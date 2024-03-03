import { describe, expect, test } from 'vitest'
import { contextItemMentionNodeDisplayText } from './ContextItemMentionNode'

describe('contextItemMentionNodeDisplayText', () => {
    test('file', () =>
        expect(contextItemMentionNodeDisplayText({ type: 'file', uri: 'file:///foo/bar.ts' })).toBe(
            '@foo/bar.ts'
        ))

    test('symbol', () =>
        expect(
            contextItemMentionNodeDisplayText({
                type: 'symbol',
                uri: 'file:///foo/bar.ts',
                range: { start: { line: 1, character: 2 }, end: { line: 3, character: 4 } },
                symbolName: 'MySymbol',
            })
        ).toBe('@#MySymbol'))
})
