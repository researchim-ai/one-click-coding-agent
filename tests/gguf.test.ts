import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { deriveArchInfo, readGGUFMetadata } from '../electron/gguf'

function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n, 0)
  return b
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n), 0)
  return b
}

function ggufString(s: string): Buffer {
  const body = Buffer.from(s, 'utf-8')
  return Buffer.concat([u64(body.length), body])
}

describe('gguf metadata', () => {
  it('skips the unread tail of huge arrays before reading the next key', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-test-'))
    const file = path.join(tmp, 'tiny.gguf')
    const huge = Buffer.alloc(100_002, 7)
    const bytes = Buffer.concat([
      u32(0x46554747), // GGUF
      u32(3),
      u64(0), // tensor_count
      u64(2), // kv_count
      ggufString('tokenizer.ggml.tokens'),
      u32(9), // ARRAY
      u32(0), // UINT8
      u64(huge.length),
      huge,
      ggufString('after.array'),
      u32(8), // STRING
      ggufString('ok'),
    ])

    fs.writeFileSync(file, bytes)

    const meta = readGGUFMetadata(file)
    expect(meta['tokenizer.ggml.tokens']).toHaveLength(100_000)
    expect(meta['after.array']).toBe('ok')
  })

  it('derives qwen35 KV layers from full_attention_interval', () => {
    const arch = deriveArchInfo({
      'general.architecture': 'qwen35',
      'general.name': 'Qwen3.6-27B',
      'qwen35.context_length': 262144,
      'qwen35.block_count': 64,
      'qwen35.embedding_length': 5120,
      'qwen35.attention.head_count': 24,
      'qwen35.attention.head_count_kv': 4,
      'qwen35.attention.key_length': 256,
      'qwen35.full_attention_interval': 4,
    })

    expect(arch.blockCount).toBe(64)
    expect(arch.kvLayers).toBe(16)
    expect(arch.kvBytesPerLayerQ8).toBe(2176)
  })
})
