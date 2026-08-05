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
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
