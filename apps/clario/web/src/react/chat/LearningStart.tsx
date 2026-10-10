import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, BookOpen, Check, FileText, FolderOpen, GraduationCap, Upload } from "lucide-react";
import { listWikiPages } from "../../api/wiki.js";
import { learnerStore } from "../../stores/learner-store.js";
import { workspacesStore } from "../../stores/workspaces-store.js";
import { appStore } from "../../stores/app-store.js";
import type { WikiPageSummary } from "../../types/wiki.js";
import type { LearningMaterial, LearningStartInput } from "../../utils/learning-start.js";
import { DEFAULT_UPLOAD_MAX_BYTES, DEFAULT_UPLOAD_MAX_LABEL } from "../../utils/upload-limits.js";
import { useStoreSnapshot } from "../hooks.js";
import { Spinner } from "../ui/Spinner.js";
import "./learning-start.css";

interface LearningStartProps {
	onStart(input: LearningStartInput): Promise<void>;
	onDraftChange(): void;
	busy: boolean;
	modelReady: boolean;
	modelName: string;
	l1Enabled: boolean;
	l2Enabled: boolean;
	initialWorkspaceId?: string | null;
	notice?: ReactNode;
}

type MaterialKind = LearningMaterial["kind"];
const MATERIAL_OPTIONS: { kind: MaterialKind; label: string; icon: typeof BookOpen }[] = [
	{ kind: "wiki", label: "知识库", icon: BookOpen },
	{ kind: "upload", label: "上传文件", icon: Upload },
	{ kind: "text", label: "粘贴内容", icon: FileText },
	{ kind: "none", label: "从目标开始", icon: GraduationCap },
];

export function LearningStart({ onStart, onDraftChange, busy, modelReady, modelName, l1Enabled, l2Enabled, initialWorkspaceId, notice }: LearningStartProps) {
	const [goal, setGoal] = useState("");
	const [kind, setKind] = useState<MaterialKind>(l2Enabled ? "wiki" : "none");
	const [pages, setPages] = useState<WikiPageSummary[]>([]);
	const [pagesLoading, setPagesLoading] = useState(l2Enabled);
	const [pagesError, setPagesError] = useState("");
	const [reload, setReload] = useState(0);
	const [selectedPath, setSelectedPath] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [content, setContent] = useState("");
	const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId ?? "");
	const [error, setError] = useState("");
	const submitting = useRef(false);
	const [submittingUi, setSubmittingUi] = useState(false);
	const profile = useStoreSnapshot(learnerStore, () => ({ profile: learnerStore.profile, error: learnerStore.error }));
	const workspaces = useStoreSnapshot(workspacesStore, () => workspacesStore.workspaces);
	const activeGoals = l1Enabled ? profile.profile?.goals.filter(item => item.status === "active") ?? [] : [];
	const locked = busy || submittingUi;
	const selectedPage = pages.find(page => page.path === selectedPath);
	const titleOf = (page: WikiPageSummary) => page.frontmatter?.title || page.path.split("/").pop() || page.path;
	const draftChangeRef = useRef(onDraftChange);
	draftChangeRef.current = onDraftChange;
	useEffect(() => {
		setWorkspaceId(initialWorkspaceId ?? "");
		draftChangeRef.current();
	}, [initialWorkspaceId]);

	useEffect(() => {
		if (l1Enabled) void learnerStore.load();
	}, [l1Enabled]);
	useEffect(() => {
		if (!l2Enabled) { setPages([]); setPagesLoading(false); return; }
		let cancelled = false;
		setPagesLoading(true);
		setPagesError("");
		void listWikiPages().then(items => { if (!cancelled) setPages(items); })
			.catch(err => { if (!cancelled) setPagesError(err instanceof Error ? err.message : "材料加载失败"); })
			.finally(() => { if (!cancelled) setPagesLoading(false); });
		return () => { cancelled = true; };
	}, [l2Enabled, reload]);

	const changed = () => { setError(""); onDraftChange(); };
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (locked || submitting.current) return;
		setError("");
		if (!goal.trim()) { setError("请先写下这次想学会什么。"); return; }
		if (!modelReady) { setError("请先在模型设置中选择可用模型。"); return; }
		let material: LearningMaterial;
		if (kind === "wiki") {
			if (!l2Enabled || !selectedPage) { setError("请选择一份知识库材料，或切换为其他学习方式。"); return; }
			material = { kind, path: selectedPage.path, title: titleOf(selectedPage) };
		} else if (kind === "upload") {
			if (!file) { setError("请选择要学习的文件。"); return; }
			if (file.size > DEFAULT_UPLOAD_MAX_BYTES) { setError(`文件不能超过 ${DEFAULT_UPLOAD_MAX_LABEL}。`); return; }
			material = { kind, file };
		} else if (kind === "text") {
			if (!content.trim()) { setError("请粘贴要学习的内容。"); return; }
			material = { kind, content, title: goal.trim().slice(0, 60) };
		} else material = { kind: "none" };
		submitting.current = true;
		setSubmittingUi(true);
		try {
			await onStart({ goal: goal.trim(), material, workspaceId: workspaceId || undefined, persistGoal: l1Enabled });
		} catch (err) {
			setError(err instanceof Error ? err.message : "开始学习失败，请重试。已选择的材料仍保留。");
		} finally { submitting.current = false; setSubmittingUi(false); }
	};

	return (
		<section className="learning-start" aria-label="开始学习">
			<div className="learning-start-inner">
				<header className="learning-start-heading">
					<div className="learning-start-eyebrow"><BookOpen size={16} /> Clario · 学习空间</div>
					<h1>从一个目标开始</h1>
					<p>选好这次的学习内容，让理解、练习和反馈连起来。</p>
				</header>
				<div className="learning-start-steps" aria-label="学习步骤">
					<span><b>1</b> 设置目标</span><ArrowRight size={14} aria-hidden /><span><b>2</b> 选择材料</span><ArrowRight size={14} aria-hidden /><span><b>3</b> 开始学习</span>
				</div>
				{notice}
				{!modelReady ? <div className="learning-start-notice" role="status">开始前，先选择一个可用模型。<button type="button" onClick={() => appStore.openSettings("models")}>设置模型 <ArrowRight size={13} /></button></div> : null}
				<form onSubmit={event => void submit(event)}>
					<fieldset disabled={locked} className="learning-start-card">
						<legend><span>01</span> 这次想学会什么？</legend>
						<label className="sr-only" htmlFor="learning-goal">学习目标</label>
						<textarea id="learning-goal" rows={2} maxLength={500} value={goal} onChange={e => { changed(); setGoal(e.target.value); }} placeholder="例如：理解 Python 二分查找，并能独立写出边界更新" />
						{activeGoals.length ? <div className="learning-start-goals"><span>继续已有目标</span>{activeGoals.slice(0, 4).map(item => <button type="button" key={item.goal_id} className={goal === item.title ? "selected" : ""} onClick={() => { changed(); setGoal(item.title); }}>{goal === item.title ? <Check size={12} /> : null}{item.title}</button>)}</div> : null}
						{!l1Enabled ? <p className="learning-start-hint">学习状态记忆已关闭，目标仅用于本次对话。</p> : profile.error ? <p className="learning-start-hint" role="status">已有目标暂未加载。开始前会重新读取，失败时不会重复新建目标。</p> : null}
					</fieldset>
					<fieldset disabled={locked} className="learning-start-card">
						<legend><span>02</span> 用什么材料学习？</legend>
						<div className="learning-material-options" aria-label="材料来源">{MATERIAL_OPTIONS.map(option => <button key={option.kind} type="button" aria-pressed={kind === option.kind} disabled={option.kind === "wiki" && !l2Enabled} onClick={() => { changed(); setKind(option.kind); }}><option.icon size={15} />{option.label}</button>)}</div>
						<div className="learning-material-body">
							{kind === "wiki" ? pagesLoading ? <p className="learning-start-hint" role="status"><Spinner size={14} /> 正在读取知识库…</p> : pagesError ? <div role="alert" className="learning-start-error">知识库暂时无法加载。<button type="button" onClick={() => setReload(value => value + 1)}>重新加载</button></div> : !pages.length ? <div className="learning-material-empty"><BookOpen size={24} /><strong>知识库还没有材料</strong><p>上传一份笔记，或者先从学习目标开始。</p><button type="button" onClick={() => { changed(); setKind("upload"); }}>选择文件 <ArrowRight size={13} /></button></div> : <><label htmlFor="learning-wiki">选择知识库材料</label><select id="learning-wiki" value={selectedPath} onChange={e => { changed(); setSelectedPath(e.target.value); }}><option value="">选择一份材料…</option>{pages.map(page => <option key={page.path} value={page.path}>{titleOf(page)}</option>)}</select>{selectedPage ? <p className="learning-start-hint">{selectedPage.bodyPreview?.slice(0, 180) || "开始后将读取所选材料，围绕你的目标展开学习。"}</p> : <p className="learning-start-hint">使用已经保存的笔记、资料或概念页。</p>}</> : null}
							{kind === "upload" ? <><label className="learning-file-picker" htmlFor="learning-file"><Upload size={23} /><strong>{file ? file.name : "选择一份学习材料"}</strong><span>{file ? `${Math.ceil(file.size / 1024)} KB · 待上传` : `PDF、Word、Markdown、文本或图片 · 最大 ${DEFAULT_UPLOAD_MAX_LABEL}`}</span><input id="learning-file" type="file" aria-label="上传学习材料" accept=".pdf,.docx,.doc,.md,.txt,.png,.jpg,.jpeg,.webp" onChange={e => { changed(); setFile(e.target.files?.[0] ?? null); }} /></label><p className="learning-start-hint">点击开始后保存到工作区。读取失败会说明原因，不会跳过材料继续学习。</p></> : null}
							{kind === "text" ? <><label htmlFor="learning-material-text">粘贴笔记或题目</label><textarea id="learning-material-text" value={content} rows={5} maxLength={100000} onChange={e => { changed(); setContent(e.target.value); }} placeholder="把想学习的段落、笔记或题目放在这里…" /><p className="learning-start-hint">内容会作为材料文件保存在工作区，便于以后查看。</p></> : null}
							{kind === "none" ? <div className="learning-material-empty"><GraduationCap size={26} /><strong>没有材料，也可以开始</strong><p>围绕目标确认必要基础，再开始讲解和练习。</p></div> : null}
						</div>
					</fieldset>
					<div className="learning-start-destination"><FolderOpen size={16} /><label htmlFor="learning-workspace">保存到</label><select id="learning-workspace" value={workspaceId} disabled={locked} onChange={e => { changed(); setWorkspaceId(e.target.value); }}><option value="">为本次学习新建工作区</option>{workspaces.filter(ws => !ws.isTemp && !ws.id.startsWith("channel-")).map(ws => <option key={ws.id} value={ws.id}>{ws.name}</option>)}</select></div>
					{error ? <div className="learning-start-error" role="alert">{error}</div> : null}
					<div className="learning-start-submit"><div><strong>准备好就开始吧</strong><span>{modelReady ? `当前模型：${modelName}` : "请先配置模型"}</span></div><button className="inno-primary-button" type="submit" disabled={locked || !modelReady}>{locked ? <><Spinner size={16} /> 正在准备…</> : <>开始学习 <ArrowRight size={17} /></>}</button></div>
				</form>
				<footer className="learning-start-footer"><span>学习过程中随时查看</span><button type="button" onClick={() => appStore.setPage("learner")}>学习状态 <ArrowRight size={12} /></button><button type="button" onClick={() => appStore.setPage("practice")}>练习记录 <ArrowRight size={12} /></button></footer>
			</div>
		</section>
	);
}
