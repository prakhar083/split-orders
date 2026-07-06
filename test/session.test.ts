import { describe, it, expect } from 'vitest';
import { sessionDir, isLoggedOut, type LoginConfig } from '../src/session.js';

const cfg: LoginConfig = { loginUrlPattern: /\/ap\/signin|\/login/, authMarker: '#nav-user' };

describe('sessionDir', () => {
  it('points into .sessions/<source>', () => {
    expect(sessionDir('amazon').endsWith('/.sessions/amazon')).toBe(true);
  });
});

describe('isLoggedOut', () => {
  it('is true on a login URL', () => {
    expect(isLoggedOut('https://www.amazon.in/ap/signin?x=1', true, cfg)).toBe(true);
  });
  it('is true when the auth marker is absent', () => {
    expect(isLoggedOut('https://www.amazon.in/gp/css/order-history', false, cfg)).toBe(true);
  });
  it('is false when on a normal page with the auth marker present', () => {
    expect(isLoggedOut('https://www.amazon.in/gp/css/order-history', true, cfg)).toBe(false);
  });
});
