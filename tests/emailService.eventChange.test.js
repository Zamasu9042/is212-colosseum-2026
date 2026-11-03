jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

const nodemailer = require('nodemailer');
const { sendEventChangeEmail } = require('../src/services/emailService');

describe('event-change email delivery', () => {
  const environment = { ...process.env };

  beforeEach(() => {
    nodemailer.createTransport.mockReset();
    nodemailer.createTransport.mockReturnValue({ sendMail: jest.fn().mockResolvedValue({ messageId: 'mail-1' }) });
    Object.assign(process.env, {
      EMAIL_ENABLED: 'true', SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_SECURE: 'true',
      SMTP_USER: 'sender@example.com', SMTP_PASS: 'secret', MAIL_FROM: 'ConnectSphere <sender@example.com>',
    });
  });

  afterAll(() => { process.env = environment; });

  test('renders all changed details and reschedule actions in the email', async () => {
    await expect(sendEventChangeEmail({
      to: 'attendee@example.com', attendeeName: 'Alex', eventName: 'Leadership Forum',
      changes: [{ label: 'Start time', before: '1 Jun, 9:00 am', after: '2 Jun, 10:00 am' }, { label: 'Venue', before: 'Hall A', after: 'Hall B' }],
      actions: [{ label: 'Re-confirm registration', url: '/api/attendees/registrations/r1/reconfirm' }, { label: 'Withdraw registration', url: '/api/attendees/registrations/r1/withdraw' }],
    })).resolves.toEqual({ sent: true, messageId: 'mail-1' });

    const message = nodemailer.createTransport.mock.results[0].value.sendMail.mock.calls[0][0];
    expect(message).toMatchObject({ to: 'attendee@example.com', subject: 'Event update: Leadership Forum' });
    expect(message.text).toContain('Start time: 1 Jun, 9:00 am -> 2 Jun, 10:00 am');
    expect(message.text).toContain('Venue: Hall A -> Hall B');
    expect(message.text).toContain('/api/attendees/registrations/r1/reconfirm');
    expect(message.text).toContain('/api/attendees/registrations/r1/withdraw');
  });

  test('does not create an SMTP transport when email delivery is disabled', async () => {
    process.env.EMAIL_ENABLED = 'false';
    await expect(sendEventChangeEmail({ to: 'attendee@example.com', attendeeName: 'Alex', eventName: 'Forum', changes: [] }))
      .resolves.toEqual({ sent: false, skipped: true });
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });
});
