<script lang="ts">
	import { Image, Square } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import {
		ChatFormActionFileAttachments,
		ChatFormActionRecord,
		ChatFormActionSubmit,
		ModelsSelector
	} from '$lib/components/app';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { FileTypeCategory } from '$lib/enums';
	import { getFileTypeCategory } from '$lib/utils';
	import { config, settingsStore } from '$lib/stores/settings.svelte';
	import { modelsStore, modelOptions, selectedModelId } from '$lib/stores/models.svelte';
	import { isRouterMode } from '$lib/stores/server.svelte';
	import { chatStore, imageToolsEnabled, setImageToolsEnabled } from '$lib/stores/chat.svelte';
	import { activeMessages, usedModalities } from '$lib/stores/conversations.svelte';
	import { useModelChangeValidation } from '$lib/hooks/use-model-change-validation.svelte';

	interface Props {
		canSend?: boolean;
		class?: string;
		disabled?: boolean;
		isLoading?: boolean;
		isRecording?: boolean;
		hasText?: boolean;
		uploadedFiles?: ChatUploadedFile[];
		onFileUpload?: (fileType?: FileTypeCategory) => void;
		onMicClick?: () => void;
		onStop?: () => void;
	}

	let {
		canSend = false,
		class: className = '',
		disabled = false,
		isLoading = false,
		isRecording = false,
		hasText = false,
		uploadedFiles = [],
		onFileUpload,
		onMicClick,
		onStop
	}: Props = $props();

	let currentConfig = $derived(config());
	let isRouter = $derived(isRouterMode());
	const imageSystemPrompt =
		'You must generate images by calling the tool. Respond ONLY with a tool call in this exact XML format:\n' +
		'<tool_call>t2i_model_generation\n' +
		'<arg_key>discrete_image_token</arg_key>\n' +
		'<arg_value><|discrete_image_start|>...<|discrete_image_end|></arg_value>\n' +
		'</tool_call>';
	let previousSystemPrompt = $state<string | null>(null);

	let conversationModel = $derived(
		chatStore.getConversationModel(activeMessages() as DatabaseMessage[])
	);

	let previousConversationModel: string | null = null;

	$effect(() => {
		if (conversationModel && conversationModel !== previousConversationModel) {
			previousConversationModel = conversationModel;
			modelsStore.selectModelByName(conversationModel);
		}
	});

	let activeModelId = $derived.by(() => {
		const options = modelOptions();

		if (!isRouter) {
			return options.length > 0 ? options[0].model : null;
		}

		const selectedId = selectedModelId();
		if (selectedId) {
			const model = options.find((m) => m.id === selectedId);
			if (model) return model.model;
		}

		if (conversationModel) {
			const model = options.find((m) => m.model === conversationModel);
			if (model) return model.model;
		}

		return null;
	});

	let modelPropsVersion = $state(0); // Used to trigger reactivity after fetch

	$effect(() => {
		if (activeModelId) {
			const cached = modelsStore.getModelProps(activeModelId);

			if (!cached) {
				modelsStore.fetchModelProps(activeModelId).then(() => {
					modelPropsVersion++;
				});
			}
		}
	});

	let hasAudioModality = $derived.by(() => {
		if (activeModelId) {
			void modelPropsVersion;

			return modelsStore.modelSupportsAudio(activeModelId);
		}

		return false;
	});

	let hasVisionModality = $derived.by(() => {
		if (activeModelId) {
			void modelPropsVersion;

			return modelsStore.modelSupportsVision(activeModelId);
		}

		return false;
	});

	let hasAudioAttachments = $derived(
		uploadedFiles.some((file) => getFileTypeCategory(file.type) === FileTypeCategory.AUDIO)
	);
	let shouldShowRecordButton = $derived(
		hasAudioModality && !hasText && !hasAudioAttachments && currentConfig.autoMicOnEmpty
	);

	let hasModelSelected = $derived(!isRouter || !!conversationModel || !!selectedModelId());

	let isSelectedModelInCache = $derived.by(() => {
		if (!isRouter) return true;

		if (conversationModel) {
			return modelOptions().some((option) => option.model === conversationModel);
		}

		const currentModelId = selectedModelId();
		if (!currentModelId) return false;

		return modelOptions().some((option) => option.id === currentModelId);
	});

	let submitTooltip = $derived.by(() => {
		if (!hasModelSelected) {
			return 'Please select a model first';
		}

		if (!isSelectedModelInCache) {
			return 'Selected model is not available, please select another';
		}

		return '';
	});

	let isImageModeActive = $derived(imageToolsEnabled());

	function toggleImageMode() {
		const currentPrompt = currentConfig.systemMessage?.toString() ?? '';

		if (imageToolsEnabled()) {
			settingsStore.updateMultipleConfig({
				systemMessage: previousSystemPrompt ?? '',
			});
			setImageToolsEnabled(false);
			previousSystemPrompt = null;
			return;
		}

		previousSystemPrompt = currentPrompt;
		settingsStore.updateMultipleConfig({
			systemMessage: imageSystemPrompt
		});
		setImageToolsEnabled(true);
	}

	let selectorModelRef: ModelsSelector | undefined = $state(undefined);

	export function openModelSelector() {
		selectorModelRef?.open();
	}

	const { handleModelChange } = useModelChangeValidation({
		getRequiredModalities: () => usedModalities(),
		onValidationFailure: async (previousModelId) => {
			if (previousModelId) {
				await modelsStore.selectModelById(previousModelId);
			}
		}
	});
</script>

<div class="flex w-full items-center gap-3 {className}" style="container-type: inline-size">
	<div class="mr-auto flex items-center gap-1">
		<ChatFormActionFileAttachments
			{disabled}
			{hasAudioModality}
			{hasVisionModality}
			{onFileUpload}
		/>

		<Tooltip.Root>
			<Tooltip.Trigger>
				<Button
					aria-pressed={isImageModeActive}
					class="h-8 w-8 rounded-full bg-transparent p-0 text-muted-foreground hover:bg-foreground/10 hover:text-foreground {isImageModeActive
						? 'bg-foreground/10 text-foreground'
						: ''}"
					disabled={!hasVisionModality || disabled}
					onclick={toggleImageMode}
					type="button"
				>
					<span class="sr-only">
						{isImageModeActive ? 'Disable image generation mode' : 'Enable image generation mode'}
					</span>
					<Image class="h-4 w-4" />
				</Button>
			</Tooltip.Trigger>

			{#if !hasVisionModality}
				<Tooltip.Content>
					<p>Current model does not support image generation</p>
				</Tooltip.Content>
			{:else}
				<Tooltip.Content>
					<p>
						{isImageModeActive
							? 'Image generation mode is on'
							: 'Enable image generation mode'}
					</p>
				</Tooltip.Content>
			{/if}
		</Tooltip.Root>
	</div>

	<ModelsSelector
		{disabled}
		bind:this={selectorModelRef}
		currentModel={conversationModel}
		forceForegroundText={true}
		useGlobalSelection={true}
		onModelChange={handleModelChange}
	/>

	{#if isLoading}
		<Button
			type="button"
			onclick={onStop}
			class="h-8 w-8 bg-transparent p-0 hover:bg-destructive/20"
		>
			<span class="sr-only">Stop</span>
			<Square class="h-8 w-8 fill-destructive stroke-destructive" />
		</Button>
	{:else if shouldShowRecordButton}
		<ChatFormActionRecord {disabled} {hasAudioModality} {isLoading} {isRecording} {onMicClick} />
	{:else}
		<ChatFormActionSubmit
			canSend={canSend && hasModelSelected && isSelectedModelInCache}
			{disabled}
			{isLoading}
			tooltipLabel={submitTooltip}
			showErrorState={hasModelSelected && !isSelectedModelInCache}
		/>
	{/if}
</div>
