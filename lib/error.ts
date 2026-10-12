import { BaseError, UserRejectedRequestError } from "viem";

export const isUserRejected = (error: Error | null): boolean => {
  if (error instanceof BaseError) {
    const isRejected = error.walk((e) => e instanceof UserRejectedRequestError);
    return !!isRejected;
  }
  return false;
};
