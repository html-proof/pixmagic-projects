import { connect } from "cloudflare:sockets";
import type { SmtpConnect, SmtpSocket } from "@app/core";

/**
 * Outbound TCP for SMTP email accounts (packages/core/src/email/smtp.ts). Implicit TLS on 465,
 * STARTTLS otherwise; the runtime verifies certificates and offers no way to skip that. Port 25 is
 * blocked on Workers. The host has already been vetted (vetSmtpHost) before this is called.
 */
export const workersSmtpConnect: SmtpConnect = async ({ host, port, implicitTls }) => {
  const socket = connect({ hostname: host, port }, { secureTransport: implicitTls ? "on" : "starttls", allowHalfOpen: false });
  await socket.opened;
  return wrap(socket);
};

function wrap(socket: Socket): SmtpSocket {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  return {
    async read() {
      const r = await reader.read();
      return r.done ? null : (r.value as Uint8Array);
    },
    write: (data) => writer.write(data),
    async startTls() {
      reader.releaseLock();
      writer.releaseLock();
      const tls = socket.startTls();
      await tls.opened;
      return wrap(tls);
    },
    async close() {
      await socket.close().catch(() => undefined);
    },
  };
}
