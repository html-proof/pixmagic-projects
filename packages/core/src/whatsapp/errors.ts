import { AppError } from "../errors.js";

/** A WhatsApp rule the merchant broke, or a step they have to take first (the message is written for them). */
export class WhatsappError extends AppError {
  constructor(message: string, status: 400 | 404 | 409, code: string, detail?: unknown) {
    super(message, status, code, detail);
    this.name = "WhatsappError";
  }
}
