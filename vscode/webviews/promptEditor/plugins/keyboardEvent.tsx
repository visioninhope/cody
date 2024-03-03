import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { COMMAND_PRIORITY_LOW, KEY_DOWN_COMMAND, KEY_ESCAPE_COMMAND } from 'lexical'
import { type FunctionComponent, useLayoutEffect } from 'react'
import { editorSelectionStart } from '../BaseEditor'

export interface KeyboardEventPluginProps {
    onKeyDown?: (event: KeyboardEvent, caretPosition: number) => void
    onEscapeKey?: () => void
}

export const KeyboardEventPlugin: FunctionComponent<KeyboardEventPluginProps> = ({
    onKeyDown,
    onEscapeKey,
}) => {
    const [editor] = useLexicalComposerContext()

    useLayoutEffect(() => {
        const disposables: (() => void)[] = []
        if (onKeyDown) {
            disposables.push(
                editor.registerCommand(
                    KEY_DOWN_COMMAND,
                    event => {
                        onKeyDown?.(event, editorSelectionStart(editor.getEditorState()) ?? 0)
                        return false
                    },
                    COMMAND_PRIORITY_LOW
                )
            )
        }
        if (onEscapeKey) {
            disposables.push(
                editor.registerCommand(
                    KEY_ESCAPE_COMMAND,
                    () => {
                        onEscapeKey?.()
                        return false
                    },
                    COMMAND_PRIORITY_LOW
                )
            )
        }
        return () => {
            for (const disposable of disposables) {
                disposable()
            }
        }
    }, [editor, onKeyDown, onEscapeKey])

    return null
}
