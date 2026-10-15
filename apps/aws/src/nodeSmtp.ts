import { once } from "node:events";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { SmtpConnect, SmtpSocket } from "@app/core";

/**
 * Outbound TCP for merchants' SMTP accounts (packages/core/src/email/smtp.ts). Implicit TLS on 465, STARTTLS
 * otherwise; certificates are always verified (Node's default, never turned off here). The caller
 * has vetted the host and applies its own timeouts. Lambda leaves the VPC through the NAT gateway;
 * port 25 is blocked there.
 */
export const nodeSmtpConnect: SmtpConnect = async ({ host, port, implicitTls }) => {
  const socket = implicitTls ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
  await once(socket, implicitTls ? "secureConnect" : "connect");
  return wrap(socket, host);
};

function wrap(socket: Socket | TLSSocket, host: string): SmtpSocket {
  const chunks: Uint8Array[] = [];
  const waiting: Array<{ resolve: (c: Uint8Array | null) => void; reject: (e: Error) => void }> = [];
  let ended = false;
  let failure: Error | null = null;

  const onData = (chunk: Buffer) => {
    const next = waiting.shift();
    if (next) next.resolve(new Uint8Array(chunk));
    else chunks.push(new Uint8Array(chunk));
  };
  const onEnd = () => {
    ended = true;
    for (const w of waiting.splice(0)) w.resolve(null);
  };
  const onError = (err: Error) => {
    failure = err;
    for (const w of waiting.splice(0)) w.reject(err);
  };
  socket.on("data", onData);
  socket.on("end", onEnd);
  socket.on("close", onEnd);
  socket.on("error", onError);
  const detach = () => {
    socket.off("data", onData);
    socket.off("end", onEnd);
    socket.off("close", onEnd);
    socket.off("error", onError);
    // A late error on a socket nobody listens to would crash the process.
    socket.on("error", () => undefined);
  };

  return {
    read() {
      const chunk = chunks.shift();
      if (chunk) return Promise.resolve(chunk);
      if (failure) return Promise.reject(failure);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    write(data) {
      return new Promise((resolve, reject) => socket.write(data, (err) => (err ? reject(err) : resolve())));
    },
    async startTls() {
      // The server's 220 to STARTTLS has been read; nothing else is in flight.
      detach();
      const secure = tlsConnect({ socket, servername: host });
      await once(secure, "secureConnect");
      return wrap(secure, host);
    },
    async close() {
      detach();
      socket.destroy();
    },
  };
}
