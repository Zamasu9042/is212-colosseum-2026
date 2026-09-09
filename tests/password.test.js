const { hashPassword, comparePassword, isPasswordStrongEnough } = require('../src/utils/password');

describe('Password utility', () => {
  test('hashes a password and can verify it back', async () => {
    const plain = 'Str0ngPassword';
    const hash = await hashPassword(plain);

    expect(hash).not.toBe(plain);
    expect(await comparePassword(plain, hash)).toBe(true);
    expect(await comparePassword('WrongPassword1', hash)).toBe(false);
  });

  test('rejects weak passwords', () => {
    expect(isPasswordStrongEnough('short1')).toBe(false); // too short
    expect(isPasswordStrongEnough('alllettersnonumber')).toBe(false); // no digit
    expect(isPasswordStrongEnough('12345678')).toBe(false); // no letter
    expect(isPasswordStrongEnough('Valid1Password')).toBe(true);
  });
});
