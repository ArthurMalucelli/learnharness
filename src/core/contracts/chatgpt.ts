/** Only this projection may reach UI or HTTP. Credentials stay in desktop IPC. */
export interface ChatGPTStatus {
	desktop: boolean;
	mode: "api_key" | "chatgpt";
	selectedId: string | null;
	authenticated: boolean;
	planPermission: boolean;
	pending: boolean;
	message: string | null;
	accounts: { id: string; label: string; connected: boolean }[];
	modelIds: string[];
	modelNames?: Record<string, string>;
}
export interface ChatGPTBridge {
	status(): Promise<ChatGPTStatus>;
	signIn(accountId?: string): Promise<ChatGPTStatus>;
	cancel(): Promise<ChatGPTStatus>;
	select(accountId: string): Promise<ChatGPTStatus>;
	signOut(accountId: string): Promise<ChatGPTStatus>;
	setMode(mode: ChatGPTStatus["mode"]): Promise<ChatGPTStatus>;
	manageUsage(): Promise<ChatGPTStatus>;
	onStatus(callback: (status: ChatGPTStatus) => void): () => void;
}
