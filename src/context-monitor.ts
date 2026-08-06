import type { ContextRecord, ManagerSnapshot } from "./types";
import {
	promptContainsTarget,
	type PromptHighlightTarget,
} from "./prompt-highlighting";

interface PromptPresenceExpectation {
	shouldBePresent: boolean;
	stateLabel: string;
}

export interface MonitorPayload {
	title: string;
	channel: string;
	status: string;
	statusColor: "success" | "warning" | "error" | "dim";
	content: string;
	highlightTarget?: PromptHighlightTarget;
	presenceExpected?: boolean;
	note?: string;
}

interface CapturedPromptOptions {
	showFullPrompt: boolean;
	expectation?: PromptPresenceExpectation;
}

export interface ViewItem {
	id: string;
	label: string;
	enabled?: boolean;
	locked?: boolean;
	state: string;
	detail: string;
	monitor?: MonitorPayload;
}

export function formatContextSection(files: ContextRecord[]): string {
	if (files.length === 0) return "";
	let result =
		"\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
	for (const file of files) {
		result += `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
	}
	return `${result}</project_context>\n`;
}

export function showCapturedSystemPrompt(
	snapshot: ManagerSnapshot,
	monitor: MonitorPayload,
	options: CapturedPromptOptions,
): MonitorPayload {
	const captured = snapshot.effectiveSystemPrompt;
	if (!options.showFullPrompt || !captured) return monitor;
	const isAgentPrompt = captured.source === "agent-start";
	const expectation = options.expectation;
	const found = monitor.highlightTarget
		? promptContainsTarget(captured.content, monitor.highlightTarget)
		: false;
	let status = isAgentPrompt
		? "captured after the latest agent start"
		: "captured before an agent run";
	let statusColor: MonitorPayload["statusColor"] = "success";
	let presenceExpected: boolean | undefined;
	if (expectation) {
		if (!isAgentPrompt) {
			status = `${expectation.stateLabel} · awaiting verification at the next agent start`;
			statusColor = "dim";
			presenceExpected = false;
		} else {
			presenceExpected = expectation.shouldBePresent;
			if (expectation.shouldBePresent && found) {
				status = `${expectation.stateLabel} · found in effective prompt`;
			} else if (expectation.shouldBePresent) {
				status = `${expectation.stateLabel} · NOT FOUND in effective prompt`;
				statusColor = "warning";
			} else if (found) {
				status = `${expectation.stateLabel} · FOUND IN EFFECTIVE PROMPT`;
				statusColor = "error";
			} else {
				status = `${expectation.stateLabel} · absent from effective prompt`;
			}
		}
	}
	return {
		...monitor,
		title: `${isAgentPrompt ? "Effective Prompt" : "Prompt Preview"} · ${monitor.title}`,
		channel: isAgentPrompt
			? "effective Pi system prompt"
			: "current Pi system prompt preview",
		status,
		statusColor,
		content: captured.content,
		presenceExpected,
		note: [
			monitor.status,
			isAgentPrompt
				? "This cached prompt reflects the latest agent run; current policy changes appear after the next run."
				: "This preview has not passed through this turn's before_agent_start handlers.",
			monitor.note,
		]
			.filter(Boolean)
			.join(" "),
	};
}

interface PromptSourceItemOptions {
	id: string;
	label: string;
	state: string;
	detail: string;
	channel: string;
	status: string;
	content: string;
	note?: string;
}

function createPromptSourceItem(
	snapshot: ManagerSnapshot,
	options: PromptSourceItemOptions,
): ViewItem {
	return {
		id: options.id,
		label: options.label,
		state: options.state,
		detail: options.detail,
		monitor: showCapturedSystemPrompt(
			snapshot,
			{
				title: `Prompt Source · ${options.label}`,
				channel: options.channel,
				status: options.status,
				statusColor: "success",
				content: options.content,
				highlightTarget: {
					kind: "text-span",
					text: options.content,
				},
				note: options.note,
			},
			{
				showFullPrompt: true,
				expectation: {
					shouldBePresent: true,
					stateLabel: "active",
				},
			},
		),
	};
}

export function getPromptSourceItems(snapshot: ManagerSnapshot): ViewItem[] {
	const items: ViewItem[] = [];
	if (snapshot.customSystemPrompt) {
		items.push(
			createPromptSourceItem(snapshot, {
				id: "custom-system-prompt",
				label: "Custom System Prompt",
				state: "active · read-only",
				detail:
					"Pi custom system prompt · source path unavailable through Extension API",
				channel: "system prompt base",
				status: "active · included by Pi",
				content: snapshot.customSystemPrompt,
				note: "Presence is verified by content because Pi does not expose the source path through Extension API.",
			}),
		);
	}
	if (snapshot.appendedSystemPrompt) {
		items.push(
			createPromptSourceItem(snapshot, {
				id: "appended-system-prompt",
				label: "Appended System Prompt",
				state: "active · read-only",
				detail:
					"Pi appended system prompt · merged source text; source paths unavailable through Extension API",
				channel: "system prompt append section",
				status: "active · included by Pi",
				content: snapshot.appendedSystemPrompt,
				note: "This may combine APPEND_SYSTEM.md, CLI, or SDK inputs; Pi exposes only the merged text.",
			}),
		);
	}
	if (snapshot.presetInstructions) {
		items.push(
			createPromptSourceItem(snapshot, {
				id: "preset-instructions",
				label: "Preset Instructions",
				state: `active · controlled by preset ${snapshot.presetName ?? "unknown"}`,
				detail: `Config Manager preset · ${snapshot.presetName ?? "unknown"}`,
				channel: "system prompt preset append",
				status: "active · appended by Config Manager",
				content: snapshot.presetInstructions,
			}),
		);
	}
	return items;
}

