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
  /**
   * Whether the token carries the `admin` custom claim.
   *
   * Set here rather than looked up per request: a custom claim is minted into
   * the token by Firebase itself and verified along with the signature, so by
   * the time the token is decoded this is already established fact. Granted
   * out of band with `npm run grant:admin` — nothing the API exposes can hand
   * it out, which is the point.
   */
  admin?: boolean;
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
      // Strictly `true`. A custom claim is arbitrary JSON, and a truthy
      // string left behind by a fat-fingered `setCustomUserClaims` must not
      // read as permission.
      req.admin = decoded.admin === true;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
