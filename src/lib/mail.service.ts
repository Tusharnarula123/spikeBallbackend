import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface MailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

/**
 * Thin email service backed by Resend (https://resend.com).
 * Set RESEND_API_KEY + MAIL_FROM in .env to enable.
 * If the key is absent the send() call logs a warning and returns silently —
 * never throws — so a missing key never breaks a request.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly apiKey:  string | undefined;
  private readonly from:    string;
  private readonly appUrl:  string;

  constructor(private readonly config: ConfigService) {
    this.apiKey  = config.get<string>('RESEND_API_KEY');
    this.from    = config.get<string>('MAIL_FROM') ?? 'OU Roundnet <noreply@ouroundnet.club>';
    this.appUrl  = config.get<string>('APP_URL')   ?? 'http://localhost:3000';
  }

  get baseUrl() { return this.appUrl; }

  async send(opts: MailOptions): Promise<void> {
    if (!this.apiKey) {
      this.logger.warn(`[MailService] RESEND_API_KEY not set — skipping email to ${opts.to}`);
      return;
    }

    const to = Array.isArray(opts.to) ? opts.to : [opts.to];

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to,
          subject: opts.subject,
          html: opts.html,
          text: opts.text,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.error(`[MailService] Resend error ${res.status}: ${body}`);
      }
    } catch (err) {
      this.logger.error('[MailService] Failed to send email', err);
    }
  }

  /** Convenience: send a branded notification email. */
  async sendNotification(opts: {
    to: string;
    subject: string;
    title: string;
    body: string;
    link?: string;
    linkLabel?: string;
  }): Promise<void> {
    const btnHtml = opts.link
      ? `
        <div style="text-align:center;margin:28px 0;">
          <a href="${this.appUrl}${opts.link}"
             style="background:#FFB81C;color:#0a0a0a;padding:12px 28px;border-radius:8px;
                    font-weight:700;font-size:15px;text-decoration:none;display:inline-block;">
            ${opts.linkLabel ?? 'View in Portal'}
          </a>
        </div>
      `
      : '';

    const html = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"></head>
      <body style="margin:0;padding:0;background:#f4f4f4;font-family:system-ui,sans-serif;">
        <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
          <!-- Header -->
          <div style="background:#0a0a0a;padding:24px 32px;text-align:center;">
            <p style="color:#FFB81C;font-size:20px;font-weight:800;margin:0;letter-spacing:.5px;">
              🏐 OU Roundnet
            </p>
          </div>
          <!-- Body -->
          <div style="padding:32px;">
            <h1 style="font-size:22px;font-weight:700;color:#111;margin:0 0 12px;">${opts.title}</h1>
            <p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 8px;">${opts.body}</p>
            ${btnHtml}
          </div>
          <!-- Footer -->
          <div style="background:#f9f9f9;border-top:1px solid #eee;padding:16px 32px;text-align:center;">
            <p style="font-size:12px;color:#999;margin:0;">
              OU Roundnet Club Portal &bull; This is an automated notification.
            </p>
          </div>
        </div>
      </body>
      </html>
    `;

    await this.send({ to: opts.to, subject: opts.subject, html, text: opts.body });
  }
}
