import { appStore, type WorkspaceMode } from "./app-store.js";
import {
	CHAT_BASELINE_WIDTH,
	SIDEBAR_WIDTH,
	getEffectiveWorkspaceWidth,
} from "./app-layout.js";

export type WindowExpansionSide = "left" | "right";
export type PanelSpaceResult = "ready" | "busy" | "unavailable";

/**
 * Make room for a non-overlay panel before changing the app layout.
 *
 * In a normal browser there is no native window to resize. The caller still
 * applies its requested layout when this returns "unavailable", allowing the
 * existing fitPanelLayout fallback to keep the chat usable.
 */
export async function ensureWindowForPanel(
	side: WindowExpansionSide,
	requestedWorkspaceWidth?: number,
	requestedWorkspaceMode?: WorkspaceMode,
): Promise<PanelSpaceResult> {
	const currentSidebarCollapsed = appStore.sidebarCollapsed;
	const currentWorkspaceMode = appStore.workspaceMode;
	const workspaceWidth = requestedWorkspaceWidth ?? appStore.workspaceWidth;
	const workspaceMode = requestedWorkspaceMode ?? currentWorkspaceMode;
	const leftWidth = currentSidebarCollapsed && side !== "left" ? 0 : SIDEBAR_WIDTH;
	const rightWidth = currentWorkspaceMode === "collapsed" && side !== "right"
		? 0
		: getEffectiveWorkspaceWidth(workspaceWidth, workspaceMode === "collapsed" ? "half" : workspaceMode);
	const requiredWidth = CHAT_BASELINE_WIDTH + leftWidth + rightWidth;
	const viewportWidth = typeof window === "undefined" ? requiredWidth : window.innerWidth;
	const additionalWidth = Math.max(0, requiredWidth - viewportWidth);
	if (additionalWidth === 0) return "ready";

	return "unavailable";
}
