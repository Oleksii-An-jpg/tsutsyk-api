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
