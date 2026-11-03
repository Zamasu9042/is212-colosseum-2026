const nodemailer = require('nodemailer');

let transporter;

function isEmailEnabled() {
  return process.env.EMAIL_ENABLED === 'true';
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: process.env.SMTP_SECURE !== 'false',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return transporter;
}

async function sendWithdrawalEmail({ to, attendeeName, eventName, startDatetime }) {
  if (!isEmailEnabled()) return { sent: false, skipped: true };

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.MAIL_FROM) {
    throw new Error('Email is enabled but SMTP configuration is incomplete.');
  }

  const eventTime = new Date(startDatetime).toLocaleString('en-SG', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Singapore',
  });
  const info = await getTransporter().sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject: `Withdrawal confirmed: ${eventName}`,
    text: `Hi ${attendeeName},\n\nYour registration for ${eventName} on ${eventTime} has been withdrawn. Your place has been released.\n\nConnectSphere`,
  });
  return { sent: true, messageId: info.messageId };
}

async function sendEventChangeEmail({ to, attendeeName, eventName, changes, actions = [] }) {
  if (!isEmailEnabled()) return { sent: false, skipped: true };

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.MAIL_FROM) {
    throw new Error('Email is enabled but SMTP configuration is incomplete.');
  }

  const details = changes.map(({ label, before, after }) => `- ${label}: ${before} -> ${after}`).join('\n');
  const actionText = actions.length
    ? `\n\nNext steps:\n${actions.map((action) => `- ${action.label}: ${action.url}`).join('\n')}`
    : '';
  const info = await getTransporter().sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject: `Event update: ${eventName}`,
    text: `Hi ${attendeeName},\n\n${eventName} has been updated:\n${details}${actionText}\n\nConnectSphere`,
  });
  return { sent: true, messageId: info.messageId };
}

module.exports = { sendWithdrawalEmail, sendEventChangeEmail, isEmailEnabled };
