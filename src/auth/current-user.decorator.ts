import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { AuthenticatedRequest } from './firebase-auth.guard';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const req = GqlExecutionContext.create(context).getContext<{
      req: AuthenticatedRequest;
    }>().req;
    // FirebaseAuthGuard runs first and throws if uid isn't set, so this is
    // only reached once req.uid is guaranteed to be populated.
    return req.uid;
  },
);

/**
 * The caller's uid, or null when nobody is signed in.
 *
 * The counterpart to `CurrentUser` for resolvers behind
 * `OptionalFirebaseAuthGuard`, where "no user" is a normal outcome rather
 * than a rejected request.
 */
export const CurrentUserOptional = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | null => {
    const req = GqlExecutionContext.create(context).getContext<{
      req: AuthenticatedRequest;
    }>().req;
    return req?.uid ?? null;
  },
);
