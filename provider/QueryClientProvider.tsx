"use client";
import {
    QueryClient,
    QueryClientProvider as QueryClientProviderImpl,
} from "@tanstack/react-query";
import { ReactNode } from "react";

const queryClient = new QueryClient();
/**
 *  Provides a QueryClient to the children.
 */
export function QueryClientProvider({ children }: { children: ReactNode }) {
    return (
        <QueryClientProviderImpl client={queryClient}>
            {children}
        </QueryClientProviderImpl>
    );
}
