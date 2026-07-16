import 'express-session';

declare module 'express-session' {
  interface SessionData {
    pendingMemberId?: string;
    pendingProvider?: string;
  }
}
