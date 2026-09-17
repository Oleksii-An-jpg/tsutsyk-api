import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { getAuth } from 'firebase-admin/auth';
import { getFirebaseAdminApp } from '../firebase/firebase-admin.app';

export interface AuthenticatedRequest {
  uid?: string;
  /**
   * What Firebase knows about the caller. Worth carrying: an order needs a
   * way to reach its customer, and a verified phone or email beats one typed
   * into a form — the delivery phone may well be the recipient's, not theirs.
   */
  account?: { email: string | null; phone: string | null };
}

@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = GqlExecutionContext.create(context).getContext<{
      req: AuthenticatedRequest & {
        headers: Record<string, string | undefined>;
      };
    }>().req;

    const header = req?.headers?.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      const decoded = await getAuth(getFirebaseAdminApp()).verifyIdToken(token);
      req.uid = decoded.uid;
      req.account = {
        email: decoded.email ?? null,
        phone: decoded.phone_number ?? null,
      };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
