import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest globals를 켜지 않으므로 Testing Library의 자동 cleanup이 등록되지 않는다.
afterEach(cleanup);
