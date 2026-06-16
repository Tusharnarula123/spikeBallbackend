import { ClerkUser } from '../auth/auth.types';

declare global {
  namespace Express {
    interface Request {
      authUser?: ClerkUser;
    }
  }
}

export {};
