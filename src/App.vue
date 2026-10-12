<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { BITRATES, ConvertError, convertToMp3, type Bitrate } from './lib/convert'

const file = ref<File | null>(null)
const duration = ref<number | null>(null)
const bitrate = ref<Bitrate>(192)
const dragging = ref(false)
const running = ref(false)
const label = ref('')
const ratio = ref<number | null>(null)
const error = ref('')
const detail = ref('')
const resultUrl = ref('')
const resultSize = ref(0)
const loadingSample = ref(false)

let durationToken = 0

const resultName = computed(() => {
  const name = file.value?.name.replace(/\.[^.]+$/, '') || 'audio'
  return `${name}.mp3`
})

const tooLarge = computed(() => (file.value?.size ?? 0) > 200 * 1024 * 1024)

const percent = computed(() =>
  ratio.value === null ? null : Math.round(Math.min(1, Math.max(0, ratio.value)) * 100),
)

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function formatDuration(seconds: number) {
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${rest.toString().padStart(2, '0')}`
}

function isVideo(next: File) {
  return next.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(next.name)
}

function clearResult() {
  if (resultUrl.value) URL.revokeObjectURL(resultUrl.value)
  resultUrl.value = ''
  resultSize.value = 0
  error.value = ''
  detail.value = ''
  label.value = ''
  ratio.value = null
}

function readDuration(next: File) {
  return new Promise<number | null>((resolve) => {
    const url = URL.createObjectURL(next)
    const video = document.createElement('video')
    video.preload = 'metadata'
    const done = (value: number | null) => {
      URL.revokeObjectURL(url)
      resolve(value)
    }
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? video.duration : null)
    video.onerror = () => done(null)
    video.src = url
  })
}

async function selectFile(next: File | null) {
  if (!next || running.value) return
  if (!isVideo(next)) {
    error.value = '请选择 MP4 或其他常见视频文件。'
    detail.value = ''
    return
  }
  file.value = next
  clearResult()
  duration.value = null
  const token = ++durationToken
  const seconds = await readDuration(next)
  if (token === durationToken) duration.value = seconds
}

function onInputChange(event: Event) {
  const input = event.target as HTMLInputElement
  void selectFile(input.files?.[0] ?? null)
  input.value = ''
}

function onDrop(event: DragEvent) {
  dragging.value = false
  void selectFile(event.dataTransfer?.files?.[0] ?? null)
}

async function useSample() {
  if (running.value || loadingSample.value) return
  loadingSample.value = true
  error.value = ''
  try {
    const response = await fetch('/sample.mp4')
    if (!response.ok) throw new Error('示例视频加载失败')
    const blob = await response.blob()
    await selectFile(new File([blob], 'sample.mp4', { type: 'video/mp4' }))
  } catch (err) {
    error.value = err instanceof Error ? err.message : '示例视频加载失败'
  } finally {
    loadingSample.value = false
  }
}

async function start() {
  if (!file.value || running.value) return
  running.value = true
  clearResult()
  try {
    const blob = await convertToMp3(file.value, bitrate.value, (update) => {
      label.value = update.label
      ratio.value = update.ratio
    })
    resultSize.value = blob.size
    resultUrl.value = URL.createObjectURL(blob)
    label.value = '完成'
    ratio.value = 1
  } catch (err) {
    error.value = err instanceof Error ? err.message : '转换失败'
    detail.value = err instanceof ConvertError ? err.detail : ''
    label.value = ''
    ratio.value = null
  } finally {
    running.value = false
  }
}

onBeforeUnmount(() => {
  if (resultUrl.value) URL.revokeObjectURL(resultUrl.value)
})
</script>

<template>
  <main class="page">
    <header class="hero">
      <p class="eyebrow">本地转换</p>
      <h1>MP4 转 MP3</h1>
      <p class="lede">在浏览器里抽出音轨并编码成 MP3。文件留在这台设备上，不会上传。</p>
    </header>

    <section class="panel">
      <label
        class="drop"
        :class="{ dragging, filled: file, locked: running }"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        <input
          type="file"
          accept="video/mp4,video/*,.mp4,.m4v,.mov,.webm,.mkv,.avi"
          :disabled="running"
          @change="onInputChange"
        />
        <span class="drop-title">{{ file ? '换一个视频' : '放下视频，或点击选择' }}</span>
        <span class="drop-hint">支持 MP4，也接受 MOV、WebM、MKV、AVI</span>
      </label>

      <div v-if="file" class="file">
        <div>
          <p class="file-name">{{ file.name }}</p>
          <p class="file-meta">
            {{ formatBytes(file.size) }}
            <template v-if="duration !== null"> · {{ formatDuration(duration) }}</template>
          </p>
        </div>
        <button class="text-button" type="button" :disabled="running || loadingSample" @click="useSample">
          换示例
        </button>
      </div>
      <button
        v-else
        class="text-button sample"
        type="button"
        :disabled="loadingSample"
        @click="useSample"
      >
        {{ loadingSample ? '正在载入示例…' : '没有视频？用 2 秒示例试一次' }}
      </button>

      <p v-if="tooLarge" class="warn">这个文件超过 200MB，浏览器内存可能不够。</p>

      <fieldset class="rates" :disabled="running">
        <legend>码率</legend>
        <div class="rate-row">
          <label v-for="rate in BITRATES" :key="rate" class="rate">
            <input v-model="bitrate" type="radio" name="bitrate" :value="rate" />
            <span>{{ rate }}</span>
          </label>
        </div>
      </fieldset>

      <button class="primary" type="button" :disabled="!file || running" @click="start">
        {{ running ? label || '正在转换' : '开始转换' }}
      </button>

      <div v-if="running || resultUrl" class="progress" role="status">
        <div class="progress-row">
          <span>{{ label || '正在转换' }}</span>
          <span v-if="percent !== null">{{ percent }}%</span>
        </div>
        <div
          class="track"
          :class="{ indeterminate: percent === null }"
          role="progressbar"
          :aria-valuenow="percent ?? undefined"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div class="fill" :style="percent === null ? undefined : { width: `${percent}%` }" />
        </div>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
      <details v-if="detail" class="logs">
        <summary>引擎日志</summary>
        <pre>{{ detail }}</pre>
      </details>

      <div v-if="resultUrl" class="result">
        <audio :src="resultUrl" controls />
        <a class="download" :href="resultUrl" :download="resultName">
          下载 {{ resultName }}
          <span>{{ formatBytes(resultSize) }}</span>
        </a>
      </div>
    </section>

    <p class="foot">首次转换会加载约 30MB 的引擎，只在本次打开页面时下载一次。</p>
  </main>
</template>
