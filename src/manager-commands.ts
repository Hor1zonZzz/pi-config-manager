import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import type { PresetController } from "./preset-controller";
import type { ResourceTab } from "./types";

interface ManagerCommandHandlers {
	showManager: (
		tab: ResourceTab,
		ctx: ExtensionCommandContext,
	) => Promise<void>;
}

export function registerManagerCommands(
	pi: ExtensionAPI,
	presetController: PresetController,
	handlers: ManagerCommandHandlers,
): void {
	pi.registerCommand("config-manager", {
		description: "Manage Pi tools, skills, and contexts",
		handler: async (_args, ctx) => handlers.showManager("overview", ctx),
	});
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
