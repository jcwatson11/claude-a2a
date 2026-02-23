import type { User } from "@a2a-js/sdk/server";
import type { AuthContext } from "./middleware.js";

/** Authenticated user that implements the A2A SDK User interface. */
export class AuthenticatedUser implements User {
  readonly authContext: AuthContext;

  constructor(authContext: AuthContext) {
    this.authContext = authContext;
  }

  get isAuthenticated(): boolean {
    return true;
  }

  get userName(): string {
    return this.authContext.clientName;
  }
}
