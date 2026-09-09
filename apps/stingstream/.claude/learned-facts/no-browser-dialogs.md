# Never the Browser's alert/confirm; Alert.alert Is TV-Only

**Date**: 2026-09-09
**Category**: ui
**Key files**: `utils/appDialog.ts`, `components/common/AppDialogHost.tsx`,
`components/stingstream/shared/confirm.ts`, `components/common/noBrowserDialogs.test.ts`

## Detail

Two ways of asking a question are banned in this app, and `noBrowserDialogs.test.ts` fails
the suite if either comes back.

**`globalThis.confirm` / `alert` / `prompt`.** Dan: *"NEVER use browser's alert function -
replace them with proper modals"*. It cannot be styled, prints the page's hostname above the
question, blocks the JS thread, and most browsers offer "prevent this page from creating
more dialogs" — which silently turns every later confirmation into an automatic no.

**`Alert.alert` anywhere but television.** react-native-web draws *nothing at all* for it, so
a destructive action guarded by one on the web bundle does nothing when pressed: the guard is
gone and so is the action. On TV it stays, because there it is a real native control a remote
can drive and `docs/conventions/tv.md` rules out overlay modals outright.

Use `confirmDestructive` / `confirmAction` for a question — both are promise-based, so
`const ok = await confirmDestructive(...)` works from any event handler — and `toast` for a
statement, `FormError` for a form's own failure. The dialog is rendered by `AppDialogHost`,
mounted once in `app/_layout.tsx` and driven by the module-level store in `utils/appDialog.ts`
(a store rather than a hook, because callers are mid-async-function and a hook cannot be
awaited).

## Symptom pattern

A destructive button on the web that does nothing at all when pressed, with no error — that
is `Alert.alert`. A confirmation that looks like a browser and names `127.0.0.1` — that is
`globalThis.confirm`.
