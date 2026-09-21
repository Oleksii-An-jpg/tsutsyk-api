import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { AuthenticatedRequest, FirebaseAuthGuard } from './firebase-auth.guard';

/**
 * A signed-in caller carrying the `admin` custom claim.
 *
 * Extends the ordinary guard rather than sitting beside it so that one
 * `@UseGuards(AdminGuard)` both verifies the token and checks the claim —
 * a mutation that needs an admin cannot be left half-guarded by forgetting
 * the other decorator.
 *
 * Every other mutation in the API is authorised by ownership: the caller may
 * touch an order because it is theirs. Dispatch is the first thing that is
 * nobody's order in particular — it is ours — so it needs a different kind of
 * answer, and a custom claim is one Firebase mints into the token itself.
 *
 * Granted out of band with `npm run grant:admin -- --uid=…`. Nothing the API
 * exposes can set the claim, so a compromised storefront cannot mint an admin.
 */
@Injectable()
export class AdminGuard extends FirebaseAuthGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Throws on a missing or invalid token, and populates `req.admin`. The
    // result is checked rather than assumed: today it can only be `true` or
    // an exception, and a guard is the wrong place to depend on that.
    if (!(await super.canActivate(context))) return false;

    const req = GqlExecutionContext.create(context).getContext<{
      req: AuthenticatedRequest;
    }>().req;

    if (!req.admin) {
      // Deliberately the same wording whoever asks: that this order exists,
      // or that dispatch is a thing at all, is not worth confirming to a
      // signed-in stranger poking at the schema.
      throw new ForbiddenException('Not allowed');
    }

    return true;
  }
}
