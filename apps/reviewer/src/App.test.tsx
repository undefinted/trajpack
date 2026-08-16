import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import { MockReviewApi, mockTraceIds } from "./mocks/reviewApi.js";

afterEach(cleanup);

describe("local reviewer", () => {
  it("renders provider-controlled markup only as plain text", async () => {
    const api = new MockReviewApi();
    const { container } = render(<App api={api} />);

    expect(await screen.findByRole("heading", { name: "deepseek-reasoner" })).toBeInTheDocument();
    const content = await screen.findByLabelText("事件 0 内容");
    expect(content).toHaveTextContent("<script>window.pwned = true</script>");
    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect((window as Window & { pwned?: boolean }).pwned).toBeUndefined();
  });

  it("persists per-event exclusion in the review overlay", async () => {
    const user = userEvent.setup();
    const api = new MockReviewApi();
    const { container } = render(<App api={api} />);

    await screen.findByRole("heading", { name: "deepseek-reasoner" });
    const firstEvent = container.querySelector<HTMLElement>("[data-event-id='event-1111-0']");
    expect(firstEvent).not.toBeNull();
    await user.click(within(firstEvent as HTMLElement).getByRole("button", { name: "排除" }));

    expect(await screen.findByRole("status")).toHaveTextContent("事件已从训练视图排除");
    expect(firstEvent).toHaveClass("event-card--exclude");
    const detail = await api.getTrace(mockTraceIds.deepseek);
    expect(detail.events[0]?.review.disposition).toBe("exclude");
  });

  it("saves an explicit rights override without changing the manifest default", async () => {
    const user = userEvent.setup();
    const api = new MockReviewApi();
    render(<App api={api} />);

    await screen.findByRole("heading", { name: "deepseek-reasoner" });
    await user.click(screen.getByRole("checkbox", { name: "覆盖 manifest 的默认权利" }));
    const license = screen.getByRole("textbox", { name: "SPDX / 许可表达式" });
    await user.clear(license);
    await user.type(license, "CC-BY-4.0");
    await user.selectOptions(screen.getByRole("combobox", { name: "输入权利依据" }), "licensed");
    await user.type(screen.getByRole("textbox", { name: "审阅者标识" }), "rights-reviewer-01");
    await user.type(screen.getByRole("textbox", { name: "权利证据引用" }), "contract://fixture/section-4");
    await user.type(screen.getByRole("textbox", { name: "权利证据 SHA-256" }), "a".repeat(64));
    await user.click(screen.getByRole("button", { name: "保存权利覆盖" }));

    expect(await screen.findByRole("status")).toHaveTextContent("带证据的逐事件权利覆盖已保存");
    const detail = await api.getTrace(mockTraceIds.deepseek);
    expect(detail.events[0]?.review.rights_override?.source_license_expression).toBe("CC-BY-4.0");
    expect(detail.events[0]?.review.rights_override?.input_rights_basis).toBe("licensed");
    expect(detail.events[0]?.review.rights_attestation?.evidence_ref).toBe("contract://fixture/section-4");
    expect(detail.manifest.rights.source_license_expression).toBe("Apache-2.0 AND MIT");
  });

  it("blocks approval for a trace with failed automated checks", async () => {
    const user = userEvent.setup();
    const api = new MockReviewApi();
    render(<App api={api} />);

    await screen.findByRole("heading", { name: "deepseek-reasoner" });
    await user.click(screen.getByRole("button", { name: /claude-sonnet/i }));
    expect(await screen.findByRole("heading", { name: "claude-sonnet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批准轨迹" })).toBeDisabled();
    expect(screen.getByText("训练用途许可")).toBeInTheDocument();
    expect(screen.getAllByText("失败").length).toBeGreaterThan(0);
  });

  it("requires human approval and an explicit plaintext confirmation before export", async () => {
    const user = userEvent.setup();
    const api = new MockReviewApi();
    render(<App api={api} />);

    await screen.findByRole("heading", { name: "deepseek-reasoner" });
    await user.click(screen.getByRole("button", { name: "批准轨迹" }));
    const decisionDialog = screen.getByRole("dialog", { name: "批准所选用途" });
    await user.type(within(decisionDialog).getByRole("textbox", { name: "审阅者标识" }), "reviewer-local-01");
    await user.type(within(decisionDialog).getByRole("textbox", { name: "批准依据" }), "Reviewed policy, rights, and selected purposes");
    await user.click(within(decisionDialog).getByRole("checkbox", { name: "archive" }));
    await user.click(within(decisionDialog).getByRole("checkbox", { name: /我已核对自动检查/ }));
    await user.click(within(decisionDialog).getByRole("button", { name: "确认批准" }));
    await waitFor(() => {
      const approvalAction = screen.getAllByRole("button", { name: "已批准" })
        .find((button) => button.classList.contains("button--primary"));
      expect(approvalAction).toBeDisabled();
    });

    await user.click(screen.getByRole("button", { name: "导出预检" }));
    const exportDialog = screen.getByRole("dialog", { name: "导出明文视图" });
    expect(within(exportDialog).getByRole("button", { name: "导出明文" })).toBeDisabled();
    expect(within(exportDialog).getByText("这是加密边界之外的明文副本")).toBeInTheDocument();
    await waitFor(() => expect(within(exportDialog).getByText("允许导出")).toBeInTheDocument());
    await user.click(within(exportDialog).getByRole("checkbox"));
    await user.type(within(exportDialog).getByRole("textbox", { name: /输入.*EXPORT PLAINTEXT.*确认/ }), "EXPORT PLAINTEXT");
    const exportButton = within(exportDialog).getByRole("button", { name: "导出明文" });
    expect(exportButton).toBeEnabled();
    await user.click(exportButton);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "导出明文视图" })).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("明文已导出至");
  });
});
