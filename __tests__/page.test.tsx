import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import Page from "@/app/page";

test("스캐폴드 페이지가 제목을 렌더링한다", () => {
  render(<Page />);

  expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("To get started");
});
