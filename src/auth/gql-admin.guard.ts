import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { DecodedIdToken, getAuth } from 'firebase-admin/auth';
import { getFirebaseApp } from '../firebase/firebase-admin';

interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  uid?: string;
}

// Only the account holding the Firebase `role: admin` custom claim may
// claim gadgets. This app has a single owner per deployment, so claiming
// is not a self-serve, multi-tenant operation.
@Injectable()
export class GqlAdminGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = GqlExecutionContext.create(context).getContext<{
      req: AuthedRequest;
    }>().req;

    const authHeader = req?.headers?.authorization;
    const token =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length)
        : undefined;

    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let decoded: DecodedIdToken;
    try {
      decoded = await getAuth(getFirebaseApp()).verifyIdToken(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const role: unknown = decoded.role;
    if (role !== 'admin') {
      throw new ForbiddenException('Only the account owner can claim gadgets');
    }

    req.uid = decoded.uid;
    return true;
  }
}
