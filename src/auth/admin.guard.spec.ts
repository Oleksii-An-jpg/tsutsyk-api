import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

const verifyIdToken = jest.fn();

jest.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ verifyIdToken }),
}));
jest.mock('../firebase/firebase-admin.app', () => ({
  getFirebaseAdminApp: () => ({}),
}));

import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { AdminGuard } from './admin.guard';
import { AuthenticatedRequest, FirebaseAuthGuard } from './firebase-auth.guard';

/**
 * A GraphQL execution context holding one request.
 *
 * Nest's own host rather than a hand-rolled stand-in: `GqlExecutionContext`
 * reads more off it than the four resolver arguments, and a fake that only
 * covers what today's guard touches would pass while the real thing throws.
 */
function contextFor(
  req: Partial<AuthenticatedRequest> & { headers?: unknown },
): ExecutionContext {
  return new ExecutionContextHost([undefined, undefined, { req }, undefined]);
}

function withToken(claims: Record<string, unknown>) {
  verifyIdToken.mockResolvedValue({ uid: 'uid-1', ...claims });
  return contextFor({ headers: { authorization: 'Bearer token' } });
}

beforeEach(() => verifyIdToken.mockReset());

describe('AdminGuard', () => {
  it('lets through a token carrying the claim, and records the uid', async () => {
    const context = withToken({ admin: true });

    expect(await new AdminGuard().canActivate(context)).toBe(true);

    const { req } = context.getArgByIndex<{ req: AuthenticatedRequest }>(2);
    expect(req.uid).toBe('uid-1');
    expect(req.admin).toBe(true);
  });

  it('turns away an ordinary signed-in customer', async () => {
    await expect(
      new AdminGuard().canActivate(withToken({})),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reads only a claim that is exactly true', async () => {
    // A custom claim is arbitrary JSON. `"true"`, `1` and `{}` are all
    // truthy, and none of them is somebody having been made an admin.
    for (const admin of ['true', 1, {}, 'yes', [], 'false']) {
      await expect(
        new AdminGuard().canActivate(withToken({ admin })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('will not take the claim from the request itself', async () => {
    // The request object is ours, but it travels through middleware and
    // nothing stops a body or a header from being named `admin`. The guard
    // overwrites whatever is there with what the verified token said.
    verifyIdToken.mockResolvedValue({ uid: 'uid-1' });
    const context = contextFor({
      admin: true,
      headers: { authorization: 'Bearer token' },
    });

    await expect(new AdminGuard().canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('asks for a token before it asks about the claim', async () => {
    await expect(
      new AdminGuard().canActivate(contextFor({ headers: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it('refuses a token that does not verify', async () => {
    verifyIdToken.mockRejectedValue(new Error('expired'));

    await expect(
      new AdminGuard().canActivate(
        contextFor({ headers: { authorization: 'Bearer stale' } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('FirebaseAuthGuard', () => {
  it('lets an ordinary customer in, and marks them not an admin', async () => {
    const context = withToken({ email: 'a@b.c' });

    expect(await new FirebaseAuthGuard().canActivate(context)).toBe(true);

    const { req } = context.getArgByIndex<{ req: AuthenticatedRequest }>(2);
    expect(req.admin).toBe(false);
    expect(req.account).toEqual({ email: 'a@b.c', phone: null });
  });
});
