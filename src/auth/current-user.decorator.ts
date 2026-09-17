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
 * The email and phone Firebase has for the caller, either of which may be
 * null depending on how they signed in.
 *
 * Read from the verified token rather than asked for, so an order always has
 * some way of reaching the person who placed it.
 */
export const CurrentUserContact = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const req = GqlExecutionContext.create(context).getContext<{
      req: AuthenticatedRequest;
    }>().req;
    return req?.account ?? { email: null, phone: null };
  },
);
