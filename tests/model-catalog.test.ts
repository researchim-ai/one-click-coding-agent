import { describe, expect, it } from 'vitest'
import {
  FAMILY_QWEN36_27B,
  MODEL_FAMILIES,
  MODEL_VARIANTS,
} from '../electron/resources'

describe('model catalogue', () => {
  it('includes all top-level Qwen3.6-27B GGUF quantizations', () => {
    const family = MODEL_FAMILIES.find((f) => f.id === FAMILY_QWEN36_27B)
    expect(family).toBeTruthy()
    expect(family?.repoId).toBe('unsloth/Qwen3.6-27B-GGUF')
    expect(family?.defaultQuant).toBe('27B-UD-Q3_K_XL')

    const variants = MODEL_VARIANTS.filter((v) => v.family === FAMILY_QWEN36_27B)
    const quants = variants.map((v) => v.quant).sort()

    expect(quants).toEqual([
      '27B-IQ4_NL',
      '27B-IQ4_XS',
      '27B-Q3_K_M',
      '27B-Q3_K_S',
      '27B-Q4_0',
      '27B-Q4_1',
      '27B-Q4_K_M',
      '27B-Q4_K_S',
      '27B-Q5_K_M',
      '27B-Q5_K_S',
      '27B-Q6_K',
      '27B-Q8_0',
      '27B-UD-IQ2_M',
      '27B-UD-IQ2_XXS',
      '27B-UD-IQ3_XXS',
      '27B-UD-Q2_K_XL',
      '27B-UD-Q3_K_XL',
      '27B-UD-Q4_K_XL',
      '27B-UD-Q5_K_XL',
      '27B-UD-Q6_K_XL',
      '27B-UD-Q8_K_XL',
    ].sort())

    expect(variants).toHaveLength(21)
    expect(variants.every((v) => v.repoId === 'unsloth/Qwen3.6-27B-GGUF')).toBe(true)
    expect(variants.every((v) => v.sizeMb > 0)).toBe(true)
  })
})
