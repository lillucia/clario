import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import { appStore } from "../stores/app-store.js";
import { WORKSPACE_DEFAULT_WIDTH } from "../stores/app-layout.js";
import { sessionsStore } from "../stores/sessions-store.js";
import { workspaceStore } from "../stores/workspace-store.js";
import { workspacesStore } from "../stores/workspaces-store.js";
import { useStoreSnapshot } from "./hooks.js";
import { RunsPanel } from "./terminal/RunsPanel.js";

/** Browsing practice records does not activate or change the chat session. */
export function PracticePage() {
	const { t } = useTranslation();
	const { sessions, currentSessionId, loadingSessions } = useStoreSnapshot(sessionsStore, () => ({
		sessions: sessionsStore.sessions,
		currentSessionId: sessionsStore.currentSessionId,
		loadingSessions: sessionsStore.isLoading,
	}));
	const { workspaces, loadingWorkspaces, workspaceError } = useStoreSnapshot(workspacesStore, () => ({
		workspaces: workspacesStore.workspaces,
		loadingWorkspaces: workspacesStore.isLoading,
		workspaceError: workspacesStore.error,
	}));
	const [selectedSession, setSelectedSession] = useState<string | null>(currentSessionId);
	const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);
	const sessionId = sessions.find((session) => session.id === selectedSession)?.id
		?? sessions.find((session) => session.id === currentSessionId)?.id
		?? sessions[0]?.id;
	const sessionWorkspace = workspaces.find((workspace) => workspace.sessionIds?.includes(sessionId ?? ""));
	const workspaceId = workspaces.find((workspace) => workspace.id === selectedWorkspace)?.id
		?? sessionWorkspace?.id
		?? workspaces[0]?.id;

	async function openWorkspace() {
		const workspace = workspaces.find((entry) => entry.id === workspaceId);
		if (!workspace) return;
		const linkedSessions = sessions.filter((session) => workspace.sessionIds?.includes(session.id));
		const targetSession = linkedSessions.find((session) => session.id === sessionId)
			?? linkedSessions.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
		appStore.setPage("chat");
		if (targetSession) {
			await sessionsStore.openSession(targetSession.id);
			// Failed history loads and a newer navigation both leave this target.
			if (sessionsStore.currentSessionId !== targetSession.id) return;
		} else {
			sessionsStore.beginNewSessionIn(workspace.id);
		}
		void workspaceStore.setActiveWorkspace(workspace.id);
		appStore.setRightPanelTab("preview");
		appStore.setWorkspaceWidth(WORKSPACE_DEFAULT_WIDTH);
		appStore.setWorkspaceMode("half");
	}

	return (
		<div className="flex h-full min-h-[480px] flex-col gap-5 p-5 text-sm text-[var(--inno-text)]">
			<section className="shrink-0 rounded-xl border border-[var(--inno-border)] bg-[var(--inno-card-bg)] p-4">
				<label htmlFor="practice-workspace" className="mb-2 block font-medium">{t("learning.practice.workspace", "学习工作区")}</label>
				<p className="mb-3 text-xs leading-relaxed text-[var(--inno-text-muted)]">{t("learning.practice.workspaceHelp", "打开关联对话与工作区，查看资料、编辑练习文件或运行代码。没有关联对话时，会为这个工作区准备一次新学习。")}</p>
				{workspaces.length > 0 ? (
					<div className="flex flex-wrap items-center gap-2">
						<select id="practice-workspace" className="min-w-0 flex-1 rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2" value={workspaceId ?? ""} onChange={(event) => setSelectedWorkspace(event.target.value)}>
							{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
						</select>
						<button type="button" onClick={() => void openWorkspace()} className="inno-primary-button flex items-center gap-2 rounded-lg px-3 py-2">
							<FolderOpen size={15} />{t("learning.practice.openWorkspace", "打开工作区")}
						</button>
					</div>
				) : <p className="text-xs text-[var(--inno-text-muted)]">{loadingWorkspaces ? t("common.loading") : t("learning.practice.noWorkspace", "开始一次学习后，可以在这里查看工作区。")}</p>}
				{workspaceError && <p role="alert" className="mt-2 text-xs text-[var(--inno-danger)]">{workspaceError}</p>}
			</section>

			<section className="flex min-h-0 flex-1 flex-col gap-3">
				<div className="shrink-0">
					<label htmlFor="practice-session" className="mb-2 block font-medium">{t("learning.practice.records", "练习记录")}</label>
					<p className="mb-3 text-xs leading-relaxed text-[var(--inno-text-muted)]">
						{t("learning.practice.evidenceHint", "这里记录命令和输出。退出码 0 仅表示命令正常结束，不能单独证明已掌握知识。")}
						{" "}<button type="button" className="text-[var(--inno-accent)] underline underline-offset-2" onClick={() => appStore.setPage("learner")}>{t("learning.practice.viewState", "查看学习状态与证据")}</button>
					</p>
					{sessions.length > 0 && <select id="practice-session" className="w-full rounded-lg border border-[var(--inno-border)] bg-[var(--inno-surface)] px-3 py-2" value={sessionId ?? ""} onChange={(event) => { setSelectedSession(event.target.value); setSelectedWorkspace(null); }}>
						{sessions.map((session) => <option key={session.id} value={session.id}>{session.name}{session.archived ? ` · ${t("sidebar.archived")}` : ""}</option>)}
					</select>}
				</div>
				{sessionId ? (
					<div className="min-h-[250px] flex-1 overflow-hidden rounded-xl border border-[var(--inno-border)]">
						{/* Remount per session: the existing drawer owns selected run/detail state. */}
						<RunsPanel key={sessionId} sessionId={sessionId} onClose={() => appStore.setPage("chat")} />
					</div>
				) : (
					<div className="rounded-xl border border-dashed border-[var(--inno-border)] p-8 text-center text-[var(--inno-text-muted)]">
						<p>{loadingSessions ? t("common.loading") : t("learning.practice.empty", "还没有学习会话。开始学习并运行一次练习后，记录会出现在这里。")}</p>
						{!loadingSessions && <button type="button" className="inno-primary-button mt-4 rounded-lg px-4 py-2" onClick={() => appStore.setPage("chat")}>{t("learning.nav.start", "开始学习")}</button>}
					</div>
				)}
			</section>
		</div>
	);
}
