import {
  BaseError,
  ContractFunctionRevertedError,
  InsufficientFundsError,
  UserRejectedRequestError,
} from "viem";

const REVERT_PATTERNS: [pattern: string, message: string][] = [
  ["Insufficient funds", "가스가 부족해요."],
  // ["Too little received", "..."],
];

export const isUserRejected = (error: Error | null): boolean => {
  if (error instanceof BaseError) {
    const isRejected = error.walk((e) => e instanceof UserRejectedRequestError);
    return !!isRejected;
  }
  return false;
};

export const parseRevertReason = (error: Error | null): string | null => {
  if (error instanceof BaseError) {
    const found = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (found instanceof ContractFunctionRevertedError) {
      const reason = found.reason;
      const matched = REVERT_PATTERNS.find(([pattern]) =>
        reason?.includes(pattern),
      );
      return matched?.[1] ?? null;
    }
  }
  return null;
};

export const isInsufficientFunds = (error: Error | null): boolean => {
  if (error instanceof BaseError) {
    return !!error.walk((e) => e instanceof InsufficientFundsError);
  }
  return false;
};
