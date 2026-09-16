import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { getAuth } from 'firebase-admin/auth';
import { getFirebaseAdminApp } from '../firebase/firebase-admin.app';
import { AuthenticatedRequest } from './firebase-auth.guard';

/**
 * Identifies the caller when it can, and lets them through when it cannot.
 *
 * For endpoints open to guests where being signed in still changes the
 * outcome — placing an order attaches it to the account, so the customer can
 * manage it later without claiming it by hand. An expired token is treated as
 * "nobody", never as a failure: a stale token in a tab left open overnight
 * must not stop somebody buying a tracker.
 */
@Injectable()
export class OptionalFirebaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(OptionalFirebaseAuthGuard.name);

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = GqlExecutionContext.create(context).getContext<{
      req: AuthenticatedRequest & {
        headers: Record<string, string | undefined>;
      };
    }>().req;

    const header = req?.headers?.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    if (!token) return true;

    try {
      const decoded = await getAuth(getFirebaseAdminApp()).verifyIdToken(token);
      req.uid = decoded.uid;
    } catch {
      this.logger.debug(
        'ignoring an unverifiable token; continuing as a guest',
      );
    }

    return true;
  }
}
