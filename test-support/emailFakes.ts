// Fakes for the email integration tests: an SMTP server spoken to through the same socket
// interface Workers' TCP sockets implement, DNS-over-HTTPS answers, and OAuth providers' ID tokens.
// Type-only imports: this folder has no link to the workspace packages at runtime.
import type { SmtpConnect, SmtpSocket } from "../packages/core/src/email/smtp.js";

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** An unsigned JWT with these claims (the code reads ID tokens straight from the token endpoint over TLS). */
export function idToken(claims: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "RS256", typ: "JWT" })}.${b({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`;
}

/**
 * DNS over HTTPS (Cloudflare's JSON API shape). `records` maps `name|TYPE` to answers; anything else
 * is NXDOMAIN. `fail` makes every lookup a SERVFAIL.
 */
export function dohResponse(url: URL, records: Record<string, string[]>, fail = false): Response {
  if (fail) return json({ Status: 2 });
  const name = url.searchParams.get("name")!;
  const type = url.searchParams.get("type")!;
  const code = { A: 1, AAAA: 28, TXT: 16, CNAME: 5, MX: 15 }[type as "A"] ?? 0;
  const answers = records[`${name}|${type}`];
  if (!answers) return json({ Status: 3 });
  return json({ Status: 0, Answer: answers.map((data) => ({ name, type: code, data: type === "TXT" ? `"${data}"` : data })) });
}

export const isDoh = (url: URL) => url.hostname === "cloudflare-dns.com" || url.hostname === "dns.google";

export interface FakeSmtpOptions {
  password?: string;
  /** Offer STARTTLS on plain connections (default true). */
  starttls?: boolean;
  /** The TLS upgrade fails (bad certificate). */
  failTls?: boolean;
  /** Refuse the TCP connection. */
  refuse?: boolean;
  /** Reply to MAIL FROM / RCPT TO / end of DATA with this instead of 250. */
  mailReply?: string;
  rcptReply?: string;
  dataReply?: string;
  /** Never answer after the message data (the connection hangs). */
  hangAfterData?: boolean;
}

export interface FakeSmtp {
  connect: SmtpConnect;
  delivered: Array<{ from: string; to: string; data: string }>;
  connections: Array<{ host: string; port: number; implicitTls: boolean; tls: boolean; authed: boolean }>;
  opts: FakeSmtpOptions;
}

export function fakeSmtp(initial: FakeSmtpOptions = {}): FakeSmtp {
  const delivered: FakeSmtp["delivered"] = [];
  const connections: FakeSmtp["connections"] = [];
  const opts: FakeSmtpOptions = { password: "right-password", starttls: true, ...initial };
  const enc = new TextEncoder();
  const connect: SmtpConnect = async ({ host, port, implicitTls }) => {
    if (opts.refuse) throw new Error("connection refused");
    const conn = { host, port, implicitTls, tls: implicitTls, authed: false };
    connections.push(conn);
    const out: Uint8Array[] = [];
    let waiter: ((v: Uint8Array | null) => void) | null = null;
    let closed = false;
    let buf = "";
    let inData = false;
    let data = "";
    let from = "";
    let to = "";
    let loginStep = 0;
    let loginUser = "";
    const push = (s: string) => {
      const chunk = enc.encode(s);
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(chunk);
      } else out.push(chunk);
    };
    const handle = (line: string) => {
      if (inData) {
        if (line === ".") {
          inData = false;
          delivered.push({ from, to, data: data.replace(/^\.\./gm, ".") });
          data = "";
          if (opts.hangAfterData) return;
          push(`${opts.dataReply ?? "250 2.0.0 Ok: queued as FAKE123"}\r\n`);
        } else data += `${line}\r\n`;
        return;
      }
      if (loginStep === 1) {
        loginUser = Buffer.from(line, "base64").toString();
        loginStep = 2;
        return push("334 UGFzc3dvcmQ6\r\n");
      }
      if (loginStep === 2) {
        loginStep = 0;
        const ok = Buffer.from(line, "base64").toString() === opts.password && !!loginUser;
        conn.authed = ok;
        return push(ok ? "235 2.7.0 Authentication successful\r\n" : "535 5.7.8 Authentication credentials invalid\r\n");
      }
      const cmd = line.split(" ")[0]!.toUpperCase();
      switch (cmd) {
        case "EHLO":
          return push(`250-fake.test\r\n${!conn.tls && opts.starttls ? "250-STARTTLS\r\n" : ""}${conn.tls ? "250-AUTH PLAIN LOGIN\r\n" : ""}250 8BITMIME\r\n`);
        case "STARTTLS":
          return push("220 2.0.0 Ready to start TLS\r\n");
        case "AUTH": {
          if (!conn.tls) return push("530 5.7.0 Must issue a STARTTLS command first\r\n");
          const [, mech, arg] = line.split(" ");
          if (mech === "LOGIN") {
            loginStep = 1;
            return push("334 VXNlcm5hbWU6\r\n");
          }
          const [, user, pass] = Buffer.from(arg ?? "", "base64").toString().split("\u0000");
          const ok = !!user && pass === opts.password;
          conn.authed = ok;
          return push(ok ? "235 2.7.0 Authentication successful\r\n" : "535 5.7.8 Authentication credentials invalid\r\n");
        }
        case "MAIL":
          from = /<([^>]*)>/.exec(line)?.[1] ?? "";
          return push(`${conn.authed ? (opts.mailReply ?? "250 2.1.0 Ok") : "530 5.7.0 Authentication required"}\r\n`);
        case "RCPT":
          to = /<([^>]*)>/.exec(line)?.[1] ?? "";
          return push(`${opts.rcptReply ?? "250 2.1.5 Ok"}\r\n`);
        case "DATA":
          inData = true;
          return push("354 End data with <CR><LF>.<CR><LF>\r\n");
        case "QUIT":
          return push("221 2.0.0 Bye\r\n");
        default:
          return push("502 5.5.2 Command not recognized\r\n");
      }
    };
    const socket: SmtpSocket = {
      read: () => {
        if (out.length) return Promise.resolve(out.shift()!);
        if (closed) return Promise.resolve(null);
        return new Promise((r) => (waiter = r));
      },
      async write(d) {
        buf += new TextDecoder().decode(d);
        let i: number;
        while ((i = buf.indexOf("\r\n")) !== -1) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          handle(line);
        }
      },
      async startTls() {
        if (opts.failTls) throw new Error("TLS handshake failed: certificate has expired");
        conn.tls = true;
        return socket;
      },
      async close() {
        closed = true;
        if (waiter) {
          const w = waiter;
          waiter = null;
          w(null);
        }
      },
    };
    push("220 fake.test ESMTP\r\n");
    return socket;
  };
  return { connect, delivered, connections, opts };
}
