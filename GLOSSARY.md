# Glossary

**Series** (作品)
A single manga title, e.g. one ongoing work, regardless of which site it is read on.
_Avoid_: book, comic, manga (when meaning one title)

**Provisional Series** (臨時作品)
A Series created automatically when translation starts with no Series chosen. It behaves like any other Series until the reader names it or merges it into an existing one.
_Avoid_: unsorted, inbox

**Episode** (話)
One installment of a Series, as published.
_Avoid_: chapter (unless the site itself uses it), issue

**Page** (頁)
One manga page image as the reader sees it on the site. The same Page read on different sites is still one Page.
_Avoid_: image, screen

**Spread** (跨頁 / 見開き)
Two Pages shown side by side as the reader sees them.
_Avoid_: double page, two-page view

**Panel** (格 / コマ)
One frame of a Page, bounded by panel borders.
_Avoid_: frame, cell

**Balloon** (對話框)
A speech or thought bubble within a Panel that contains dialogue. Text outside Balloons (sound effects, narration, signs) is not a Balloon.
_Avoid_: bubble, text box

**Loose Text** (框外文字)
Text on a Page that belongs to no Balloon: sound effects, narration, signs.
_Avoid_: SFX (only one kind of Loose Text), stray text

**Line** (句)
One Balloon or one Loose Text entry on a Page, as the transcript lists it in reading order; the unit that hover sync and furigana work on. Its id (b1, l1…) is only unique within its Page, so a Line is always named together with its Page.
_Avoid_: item, sentence (one Balloon can hold several sentences)

**URL Pattern** (網址模式)
A reading-page URL reduced to origin + path (query and hash ignored), remembered against a Series once the reader chooses a non-provisional Series for it. Only used to preselect that Series the next time the extension is activated on the same URL; never activates the extension by itself.
_Avoid_: site rule, domain mapping

**Display Level** (顯示層級)
Which parts of every Line the side panel shows, switched once for all Pages: 只看譯文, 原文＋譯文, 加振り仮名 (the default), 只看日文.
_Avoid_: mode, learning mode (that is the whole feature)

**Series Notes** (作品筆記)
The fixed translations a Series has settled on — names and terms, plus how each character refers to themself, speaks, and addresses others — used to keep translations consistent. The translator accumulates names and terms as it reads; how each character speaks comes only from the reader, since the text alone does not say who is speaking. The reader reviews it and occasionally corrects it. No plot progress. Belongs to the Series, shared across every site the Series is read on.
_Avoid_: context, glossary (ambiguous with this file), dictionary

**Prior Pages** (前頁)
The Pages the reader saw just before the ones on screen, in the same tab, with their text and translations; sent along when a Page is translated so the translator can follow the conversation and keep its wording. Follows what the reader actually saw, so after a jump or a page back they are not the previous Pages of the Episode.
_Avoid_: context (that word is avoided for Series Notes), history
