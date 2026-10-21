/**
 * A small SMTP client (RFC 5321) for "Connect custom SMTP": connect, EHLO, STARTTLS or implicit TLS,
 * AUTH PLAIN/LOGIN, MAIL FROM, RCPT TO, DATA, QUIT, over whatever socket `SmtpConnect` gives it:
 * a Node socket (apps/aws/src/nodeSmtp.ts) in the app, a fake one in tests.
 *
 * Encryption is never optional. Port 465 is TLS from the first byte; on 587/2525 the server must
 * offer STARTTLS and the upgrade must succeed before AUTH, or the connection is abandoned. There is
 * no fall back to plaintext and no option to skip certificate checks (nodeSmtp.ts keeps Node's
 * certificate verification on).
 *
 * The caller has already vetted the host's addresses (smtpTarget in accounts.ts): this file only
 * talks to what it is given.
 */
import { appHost } from "./common.js";

export interface SmtpSocket {
  /** Next chunk from the server; null once it closed the connection. */
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  /** Upgrade to TLS in place (after the server's 220 to STARTTLS). Throws if the handshake or certificate fails. */
  startTls(): Promise<SmtpSocket>;
  close(): Promise<void>;
}

export type SmtpConnect = (opts: { host: string; port: number; implicitTls: boolean }) => Promise<SmtpSocket>;

export type SmtpErrorCode =
  | "connect_failed"
  | "timeout"
  | "tls_failed"
  | "starttls_unavailable"
  | "auth_failed"
  | "auth_unavailable"
  | "sender_rejected"
  | "recipient_rejected"
  | "message_rejected"
  | "transient"
  | "protocol"
  /** The server may have taken the message (the connection dropped after the data was sent). */
  | "uncertain";

export interface SmtpReply {
  code: number;
  /** RFC 3463 enhanced status, e.g. 5.1.1. */
  enhanced: string | null;
  text: string;
}

export class SmtpError extends Error {
  constructor(
    message: string,
    public code: SmtpErrorCode,
    public reply: SmtpReply | null = null,
  ) {
    super(message);
    this.name = "SmtpError";
  }
}

export interface SmtpConfig {
  host: string;
  port: number;
  encryption: "tls" | "starttls";
  username: string;
  password: string;
}

export interface SmtpEnvelope {
  from: string;
  to: string;
  /** The whole message (buildMime), CRLF line endings. */
  data: string;
}

export interface SmtpResult {
  /** The server's id for the message when its 250 reply names one (`queued as ABC123`). */
  queueId: string | null;
  /** The server's final reply text, trimmed. */
  response: string;
}

export const SMTP_TIMEOUTS = { connect: 15_000, command: 30_000, data: 120_000 };

const enc = new TextEncoder();

class Session {
  private buf = "";
  private decoder = new TextDecoder();
  constructor(
    public sock: SmtpSocket,
    private commandMs: number,
  ) {}

  replaceSocket(sock: SmtpSocket) {
    this.sock = sock;
    this.buf = "";
    this.decoder = new TextDecoder();
  }

  private async line(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.buf.indexOf("\n");
      if (i !== -1) {
        const l = this.buf.slice(0, i).replace(/\r$/, "");
        this.buf = this.buf.slice(i + 1);
        return l;
      }
      if (this.buf.length > 64 * 1024) throw new SmtpError("The SMTP server sent an overlong line", "protocol");
      const left = deadline - Date.now();
      if (left <= 0) throw new SmtpError("The SMTP server didn't answer in time", "timeout");
      const chunk = await withTimeout(this.sock.read(), left);
      if (chunk === null) throw new SmtpError("The SMTP server closed the connection", "connect_failed");
      this.buf += this.decoder.decode(chunk, { stream: true });
    }
  }

  /** One reply, all its lines (`250-...` continue, `250 ...` ends it). */
  async reply(timeoutMs = this.commandMs): Promise<SmtpReply & { lines: string[] }> {
    const lines: string[] = [];
    for (;;) {
      const l = await this.line(timeoutMs);
      const m = /^(\d{3})([ -])(.*)$/.exec(l);
      if (!m) throw new SmtpError("The SMTP server sent something that isn't SMTP", "protocol");
      lines.push(m[3]!);
      if (m[2] === " " || lines.length > 100) {
        const text = lines.join(" ").trim();
        const enhanced = /^([245]\.\d{1,3}\.\d{1,3})\b/.exec(m[3]!.trim())?.[1] ?? null;
        return { code: Number(m[1]), enhanced, text: text.slice(0, 500), lines };
      }
    }
  }

  async send(line: string) {
    await this.sock.write(enc.encode(`${line}\r\n`));
  }

  async command(line: string, timeoutMs = this.commandMs) {
    await this.send(line);
    return this.reply(timeoutMs);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new SmtpError("The SMTP server didn't answer in time", "timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const looksLikeTls = (err: unknown) => /tls|ssl|certificate|handshake|x509|self.signed|secure/i.test(String((err as Error)?.message ?? err));

/** Map a reply the server gave at one stage to what went wrong. */
function failure(stage: "greeting" | "ehlo" | "auth" | "mail" | "rcpt" | "data" | "starttls", r: SmtpReply): SmtpError {
  const temporary = r.code >= 400 && r.code < 500;
  const msg = `${r.code} ${r.text}`.trim();
  if (temporary) return new SmtpError(msg, "transient", r);
  switch (stage) {
    case "auth":
      // 535 bad credentials; 534 "application-specific password required" (Gmail) or mechanism too weak; 530 auth required elsewhere.
      return new SmtpError(msg, r.code === 504 ? "auth_unavailable" : "auth_failed", r);
    case "mail":
      return new SmtpError(msg, "sender_rejected", r);
    case "rcpt":
      return new SmtpError(msg, "recipient_rejected", r);
    case "data":
      return new SmtpError(msg, "message_rejected", r);
    case "starttls":
      return new SmtpError(msg, "tls_failed", r);
    default:
      return new SmtpError(msg, "protocol", r);
  }
}

function capabilities(lines: string[]): { starttls: boolean; auth: string[] } {
  const caps = lines.slice(1).map((l) => l.trim().toUpperCase());
  const auth = caps.find((c) => c.startsWith("AUTH ") || c.startsWith("AUTH="));
  return { starttls: caps.some((c) => c === "STARTTLS"), auth: auth ? auth.slice(5).split(/\s+/).filter(Boolean) : [] };
}

/** Lines starting with a dot get another (RFC 5321 4.5.2); the message ends with CRLF.CRLF. */
export function dotStuff(data: string): string {
  const body = data.replace(/\r\n|\r|\n/g, "\r\n").replace(/^\./gm, "..");
  return `${body.endsWith("\r\n") ? body : `${body}\r\n`}.\r\n`;
}

/** The server's id for the message, when its reply names one. */
export function queueIdFrom(text: string): string | null {
  const m = /queued as ([A-Za-z0-9._@<>-]{3,100})/i.exec(text) ?? /\bid=([A-Za-z0-9._@<>-]{3,100})/i.exec(text) ?? /\b(?:ok|accepted)[: ]+([A-Za-z0-9._-]{6,100})\b/i.exec(text);
  return m ? m[1]!.replace(/[<>]/g, "") : null;
}

/**
 * Connect and sign in; then, with an envelope, send one message. Without one, it is a connection
 * test (TLS and credentials) that sends nothing.
 */
export async function smtpSend(connect: SmtpConnect, cfg: SmtpConfig, envelope?: SmtpEnvelope, timeouts: Partial<typeof SMTP_TIMEOUTS> = {}): Promise<SmtpResult> {
  const TIMEOUTS = { ...SMTP_TIMEOUTS, ...timeouts };
  let sock: SmtpSocket;
  try {
    sock = await withTimeout(connect({ host: cfg.host, port: cfg.port, implicitTls: cfg.encryption === "tls" }), TIMEOUTS.connect);
  } catch (err) {
    if (err instanceof SmtpError) throw err;
    throw new SmtpError(`Couldn't connect: ${(err as Error).message}`, looksLikeTls(err) ? "tls_failed" : "connect_failed");
  }
  const s = new Session(sock, TIMEOUTS.command);
  let dataSent = false;
  try {
    // An implicit-TLS handshake that fails surfaces on the first read.
    const greeting = await s.reply(TIMEOUTS.connect).catch((err: unknown) => {
      if (err instanceof SmtpError && err.code !== "connect_failed") throw err;
      throw new SmtpError(`The SMTP server dropped the connection: ${(err as Error).message}`, cfg.encryption === "tls" ? "tls_failed" : "connect_failed");
    });
    if (greeting.code !== 220) throw failure("greeting", greeting);
    let ehlo = await s.command(`EHLO ${appHost()}`);
    if (ehlo.code !== 250) throw failure("ehlo", ehlo);
    if (cfg.encryption === "starttls") {
      if (!capabilities(ehlo.lines).starttls) throw new SmtpError("The server doesn't offer STARTTLS on this port", "starttls_unavailable");
      const r = await s.command("STARTTLS");
      if (r.code !== 220) throw failure("starttls", r);
      try {
        s.replaceSocket(await withTimeout(s.sock.startTls(), TIMEOUTS.connect));
      } catch (err) {
        throw new SmtpError(`TLS couldn't be established: ${(err as Error).message}`, "tls_failed");
      }
      ehlo = await s.command(`EHLO ${appHost()}`).catch((err: unknown) => {
        throw err instanceof SmtpError && err.code === "connect_failed" ? new SmtpError("The TLS connection failed", "tls_failed") : err;
      });
      if (ehlo.code !== 250) throw failure("ehlo", ehlo);
    }
    // From here on the connection is encrypted.
    const auth = capabilities(ehlo.lines).auth;
    if (auth.includes("PLAIN")) {
      const r = await s.command(`AUTH PLAIN ${Buffer.from(`\u0000${cfg.username}\u0000${cfg.password}`, "utf8").toString("base64")}`);
      if (r.code !== 235) throw failure("auth", r);
    } else if (auth.includes("LOGIN")) {
      let r = await s.command("AUTH LOGIN");
      if (r.code === 334) r = await s.command(Buffer.from(cfg.username, "utf8").toString("base64"));
      if (r.code === 334) r = await s.command(Buffer.from(cfg.password, "utf8").toString("base64"));
      if (r.code !== 235) throw failure("auth", r);
    } else {
      throw new SmtpError("The server doesn't allow password sign-in (AUTH PLAIN or LOGIN) on this connection", "auth_unavailable");
    }
    if (!envelope) {
      await s.command("QUIT").catch(() => undefined);
      return { queueId: null, response: "Signed in" };
    }
    const mail = await s.command(`MAIL FROM:<${envelope.from}>`);
    if (mail.code !== 250) throw failure("mail", mail);
    const rcpt = await s.command(`RCPT TO:<${envelope.to}>`);
    if (rcpt.code !== 250 && rcpt.code !== 251) throw failure("rcpt", rcpt);
    const data = await s.command("DATA");
    if (data.code !== 354) throw failure("data", data);
    dataSent = true;
    await s.sock.write(enc.encode(dotStuff(envelope.data)));
    let done: SmtpReply;
    try {
      done = await s.reply(TIMEOUTS.data);
    } catch (err) {
      // Everything was sent, and the answer never came: the server may well have queued it.
      throw new SmtpError(`No answer after the message was sent: ${(err as Error).message}`, "uncertain");
    }
    if (done.code !== 250) throw failure("data", done);
    await s.command("QUIT").catch(() => undefined);
    return { queueId: queueIdFrom(done.text), response: done.text };
  } catch (err) {
    if (err instanceof SmtpError) {
      if (dataSent && (err.code === "timeout" || err.code === "connect_failed")) throw new SmtpError(err.message, "uncertain", err.reply);
      throw err;
    }
    throw new SmtpError((err as Error).message, dataSent ? "uncertain" : "connect_failed");
  } finally {
    await s.sock.close().catch(() => undefined);
  }
}
