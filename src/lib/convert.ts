import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg'
import type { LogEvent, ProgressEvent } from '@ffmpeg/ffmpeg'
import { toBlobURL } from '@ffmpeg/util'
import coreURL from '@ffmpeg/core?url'
import wasmURL from '@ffmpeg/core/wasm?url'

export const BITRATES = [128, 192, 256, 320] as const
export type Bitrate = (typeof BITRATES)[number]

export type ProgressUpdate = {
  ratio: number | null
  label: string
}

export class ConvertError extends Error {
  detail: string

  constructor(message: string, detail = '') {
    super(message)
    this.name = 'ConvertError'
    this.detail = detail
  }
}

let ffmpeg: FFmpeg | null = null
let loading: Promise<FFmpeg> | null = null

async function engine(onProgress: (update: ProgressUpdate) => void): Promise<FFmpeg> {
  if (ffmpeg?.loaded) return ffmpeg
  if (!loading) {
    loading = (async () => {
      onProgress({ ratio: 0, label: '正在加载转换引擎' })
      const instance = new FFmpeg()
      const [coreBlob, wasmBlob] = await Promise.all([
        toBlobURL(coreURL, 'text/javascript'),
        toBlobURL(wasmURL, 'application/wasm', true, ({ received, total }) => {
          onProgress({
            ratio: total > 0 ? Math.min(1, received / total) : null,
            label: '正在加载转换引擎',
          })
        }),
      ])
      onProgress({ ratio: null, label: '正在初始化' })
      await instance.load({ coreURL: coreBlob, wasmURL: wasmBlob })
      ffmpeg = instance
      return instance
    })()
    loading.catch(() => {
      loading = null
      ffmpeg = null
    })
  }
  return loading
}

function explain(logs: string[], code: number): string {
  const text = logs.join('\n')
  if (/does not contain any stream|matches no streams/i.test(text)) {
    return '这个视频里没有可提取的音轨。'
  }
  if (/Invalid data found|moov atom not found|End of file/i.test(text)) {
    return '文件读不出来，请换一个完整的视频。'
  }
  if (/Unknown encoder 'libmp3lame'/i.test(text)) {
    return '当前转换引擎不支持 MP3 编码。'
  }
  return `转换没有完成（退出码 ${code}）。`
}

async function quiet(task: Promise<unknown>) {
  try {
    await task
  } catch {
    // 清理虚拟文件失败不影响结果
  }
}

export async function convertToMp3(
  file: File,
  bitrate: Bitrate,
  onProgress: (update: ProgressUpdate) => void,
): Promise<Blob> {
  const ff = await engine(onProgress)
  const logs: string[] = []
  const onLog = ({ message }: LogEvent) => {
    const line = message.trim()
    if (line) logs.push(line)
  }
  const onRatio = ({ progress }: ProgressEvent) => {
    if (!Number.isFinite(progress) || progress <= 0) return
    onProgress({
      ratio: Math.min(1, progress),
      label: '正在转换成 MP3',
    })
  }

  ff.on('log', onLog)
  ff.on('progress', onRatio)
  let mounted = false
  try {
    onProgress({ ratio: null, label: '正在读取视频' })
    await quiet(ff.deleteDir('/input'))
    await ff.createDir('/input')
    await ff.mount(
      FFFSType.WORKERFS,
      { blobs: [{ name: 'source.mp4', data: file }] },
      '/input',
    )
    mounted = true
    onProgress({ ratio: 0, label: '正在转换成 MP3' })
    const code = await ff.exec([
      '-i',
      '/input/source.mp4',
      '-vn',
      '-c:a',
      'libmp3lame',
      '-b:a',
      `${bitrate}k`,
      'output.mp3',
    ])
    if (code !== 0) {
      throw new ConvertError(explain(logs, code), logs.slice(-8).join('\n'))
    }
    onProgress({ ratio: null, label: '正在生成文件' })
    const data = await ff.readFile('output.mp3')
    if (typeof data === 'string' || data.byteLength === 0) {
      throw new ConvertError('没有生成音频。', logs.slice(-8).join('\n'))
    }
    onProgress({ ratio: 1, label: '完成' })
    return new Blob([new Uint8Array(data)], { type: 'audio/mpeg' })
  } finally {
    ff.off('log', onLog)
    ff.off('progress', onRatio)
    if (mounted) await quiet(ff.unmount('/input'))
    await quiet(ff.deleteDir('/input'))
    await quiet(ff.deleteFile('output.mp3'))
  }
}
