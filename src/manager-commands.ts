import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import type { PresetController } from "./preset-controller";
import type { ResourceTab } from "./types";

type PersistentResourceKind = "tools" | "skills" | "contexts";

interface ManagerCommandHandlers {
	showManager: (
		tab: ResourceTab,
		ctx: ExtensionCommandContext,
	) => Promise<void>;
	setGlobalResource: (
		kind: PersistentResourceKind,
		name: string,
		enabled: boolean,
		ctx: ExtensionCommandContext,
	) => void;
}

function registerResourceCommand(
	pi: ExtensionAPI,
	name: PersistentResourceKind,
	handlers: ManagerCommandHandlers,
): void {
	pi.registerCommand(name, {
		description: `Manage ${name} through Pi Config Manager`,
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (
				parts[0] === "global" &&
				(parts[1] === "enable" || parts[1] === "disable") &&
				parts[2]
			) {
				handlers.setGlobalResource(
					name,
					parts.slice(2).join(" "),
					parts[1] === "enable",
					ctx,
				);
				return;
			}
			await handlers.showManager(name, ctx);
		},
	});
}

function registerStaticResourceCommand(
	pi: ExtensionAPI,
	name: "prompts" | "themes" | "extensions",
	description: string,
	handlers: ManagerCommandHandlers,
): void {
	pi.registerCommand(name, {
		description,
		handler: async (_args, ctx) => handlers.showManager(name, ctx),
	});
}

export function registerManagerCommands(
	pi: ExtensionAPI,
	presetController: PresetController,
	handlers: ManagerCommandHandlers,
): void {
	pi.registerCommand("config-manager", {
		description:
			"Manage Pi tools, skills, contexts, prompts, themes, and extensions",
		handler: async (_args, ctx) => handlers.showManager("overview", ctx),
	});
	registerResourceCommand(pi, "tools", handlers);
	registerResourceCommand(pi, "skills", handlers);
	registerResourceCommand(pi, "contexts", handlers);
	registerStaticResourceCommand(
		pi,
		"prompts",
		"Manage Pi prompt templates",
		handlers,
	);
	registerStaticResourceCommand(pi, "themes", "Manage Pi themes", handlers);
	registerStaticResourceCommand(
		pi,
		"extensions",
		"Manage Pi extensions",
		handlers,
	);
	pi.registerCommand("preset", {
		description: "Switch preset configuration",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				await presetController.showSelector(ctx);
				return;
			}
			const preset = presetController.get(name);
			if (!preset) {
				ctx.ui.notify(
					`Unknown preset "${name}". Available: ${presetController.availableNames()}`,
					"error",
				);
				return;
			}
			await presetController.apply(name, preset, ctx);
			ctx.ui.notify(`Preset "${name}" activated`, "info");
		},
	});
	pi.registerShortcut(Key.ctrlShift("u"), {
		description: "Cycle presets",
		handler: (ctx) => presetController.cycle(ctx),
	});
	pi.registerFlag("preset", {
		description: "Preset configuration to use",
		type: "string",
	});
}
