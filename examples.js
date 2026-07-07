// examples.js
// Библиотека реальных рабочих плагинов exteraGram, которые используются
// как few-shot примеры для ИИ (показываем модели, как выглядит настоящий,
// рабочий код — она гораздо точнее повторяет структуру и API).
//
// КАК ДОБАВИТЬ СВОЙ ПЛАГИН:
// 1. Найди рабочий .plugin файл
// 2. Скопируй его текст целиком в поле `code` ниже (в бэктиках `...`)
// 3. Напиши короткое описание в `description` — по нему подбираются
//    самые подходящие примеры под конкретный запрос пользователя
// 4. Можно добавлять сколько угодно штук в массив EXAMPLES
//
// Чем больше и разнообразнее будет библиотека (разные типы хуков,
// разные фичи API) — тем умнее будет ИИ.

const EXAMPLES = [
  {
    name: "deleted_gift_sender",
    description: "работа со звёздными подарками (stars gifts), TL-запросы через send_request, работа с java-объектами (dynamic_proxy, ArrayList), хук add_hook на TL-апдейты, runOnUIThread, кэш стикеров",
    code: `from dataclasses import dataclass

from java import dynamic_proxy
from java.util import ArrayList
from java.lang import Long, Runnable

from org.telegram.messenger import AndroidUtilities, MediaDataController, UserConfig
from org.telegram.tgnet import TLRPC
from org.telegram.tgnet.tl import TL_stars
from org.telegram.ui.Stars import StarsController

from base_plugin import BasePlugin, HookResult, HookStrategy
from client_utils import RequestCallback, send_request
from android_utils import log as _log

import requests

__id__ = "deleted_gift_sender"
__name__ = "Deleted Gift Sender"
__description__ = "Небольшой плагин, который позволяет легко отправить уже удаленные (скрытые с ui) подарки, возвращая их в этот самый ui"
__author__ = "@binbash_0"
__version__ = "1.1.2"
__icon__ = "binbashPlugins/0"
__min_version__ = "11.12.0"

@dataclass()
class TelegramGift:
    id: int
    price: int
    sticker_number: int = 0
    debug_name: str = ""

GIFTS_URL = "https://raw.githubusercontent.com/binbash-0/DeletedGifts-Plugin/refs/heads/main/gift_list.json"

def log(*args, sep: str = " ") -> None:
    _log(f"[DGS] {sep.join(map(str, args))}")


class RunnableCallback(dynamic_proxy(Runnable)):
    def __init__(self, callback):
        super().__init__()
        self.callback = callback

    def run(self):
        self.callback()


class DeletedGiftSender(BasePlugin):
    gifts = []
    gift_sticker_pack = ""
    gift_catalog_attempted = set()
    sticker_pack_docs = []
    injected = False

    def __init__(self):
        super().__init__()

    def refresh_deleted_gifts_list(self):
        log("Refreshing gifts list...")
        try:
            resp = requests.get(GIFTS_URL, timeout=5).json()
        except:
            resp = {}
        if len(resp.get("gifts", [])) != len(self.gifts):
            self.gifts = [TelegramGift(**g) for g in resp.get("gifts", [{"id": 0, "price": 0, "sticker_number": 0, "debug_name": "Ошибка"}])]
            self.gift_sticker_pack = resp.get("stickerpack", "DeletedGiftsStickers")
            log(f"Got new {len(self.gifts)} gifts and {self.gift_sticker_pack} stickerpack from remote server")

    def load_sticker_pack(self):
        current_account = self.get_current_account()
        try:
            mdc = MediaDataController.getInstance(current_account)
            cached_set = mdc.getStickerSetByName(self.gift_sticker_pack)
            if cached_set is not None:
                docs = self.extract_sticker_docs(cached_set)
                if docs:
                    self.sticker_pack_docs = docs
                    log(f"Sticker pack loaded from cache: {len(docs)} stickers")
                    return
        except Exception as e:
            log("Sticker pack local lookup error:", e)
        self.fetch_sticker_pack(current_account)

    def fetch_sticker_pack(self, current_account: int):
        try:
            req = TLRPC.TL_messages_getStickerSet()
            input_set = TLRPC.TL_inputStickerSetShortName()
            input_set.short_name = self.gift_sticker_pack
            req.stickerset = input_set
            req.hash = 0

            def on_result(response, error):
                if error:
                    log("Fetch sticker pack error:", error.text)
                    return
                docs = self.extract_sticker_docs(response)
                if docs:
                    self.sticker_pack_docs = docs
                    log(f"Sticker pack fetched: {len(docs)} stickers")
                else:
                    log("Sticker pack fetched but no documents found")

            send_request(req, RequestCallback(on_result))
        except Exception as e:
            log("Sticker pack request error:", e)

    def extract_sticker_docs(self, sticker_set_response):
        if sticker_set_response is None:
            return []
        docs = getattr(sticker_set_response, "documents", None)
        if docs is None:
            return []
        return list(self.iter_java_list(docs))

    def get_preview_sticker(self, index: int):
        if not self.sticker_pack_docs:
            return None
        if 0 <= index < len(self.sticker_pack_docs):
            return self.sticker_pack_docs[index]
        return self.sticker_pack_docs[0]

    def get_current_account(self) -> int:
        return UserConfig.selectedAccount

    def iter_java_list(self, items):
        if items is None:
            return
        try:
            size = items.size()
            for index in range(size):
                yield items.get(index)
            return
        except Exception:
            pass
        try:
            for item in items:
                yield item
        except Exception:
            return

    def ensure_gift_catalog(self, current_account: int):
        controller = StarsController.getInstance(current_account)
        try:
            if not getattr(controller, "giftsLoaded", False) and not getattr(controller, "giftsLoading", False):
                controller.loadStarGifts()
                self.gift_catalog_attempted.add(current_account)
        except Exception as load_error:
            log("Gift catalog load error:", load_error)

    def j_long(self, value):
        try:
            return Long.valueOf(str(int(value)))
        except Exception:
            return int(value)

    def on_plugin_load(self) -> None:
        log("Loaded!")
        self.refresh_deleted_gifts_list()
        self.load_sticker_pack()
        self.ensure_gift_catalog(self.get_current_account())
        self.add_hook("getStarGifts")

    def on_plugin_unload(self) -> None:
        self.injected = False
        log("Unloaded!")
`,
  },
  {
    name: "mention_notifier",
    description: "автоответ когда тебя упомянули/тегнули в чате, работа с TL-апдейтами (add_hook на TL_updateNewMessage), настройки плагина через ui.settings (Header, Input, Switch), get_setting, отправка текста send_text с ответом на сообщение",
    code: `__id__ = "mention_notifier"
__name__ = "Mention Notifier"
__description__ = "Replies in chat when someone mentions (tags) you"
__author__ = "@your_username"
__version__ = "1.0.2"
__min_version__ = "11.9.1"

from base_plugin import BasePlugin, HookResult, HookStrategy
from android_utils import log
from client_utils import send_text
from ui.settings import Header, Input, Switch
from org.telegram.messenger import MessageObject

UPDATE_NAMES = ("TL_updateNewMessage", "TL_updateNewChannelMessage")


class Plugin(BasePlugin):

    def on_plugin_load(self):
        for name in UPDATE_NAMES:
            self.add_hook(name)

    def on_plugin_unload(self):
        pass

    def create_settings(self):
        return [
            Header(text="Mention Notifier"),
            Switch(
                key="enabled",
                text="Enabled",
                default=True,
                subtext="Automatically reply when someone tags/mentions you",
            ),
            Input(
                key="reply_text",
                text="Reply text",
                default="Я сейчас недоступен, отвечу позже!",
                subtext="Text sent as a reply when you are mentioned",
            ),
        ]

    def on_update_hook(self, update_name, account, update):
        try:
            if not self.get_setting("enabled", True):
                return HookResult()
            if update_name not in UPDATE_NAMES:
                return HookResult()

            message = getattr(update, "message", None)
            if message is None:
                return HookResult()
            if getattr(message, "out", False):
                return HookResult()

            is_mentioned = bool(getattr(message, "mentioned", False))
            if not is_mentioned:
                return HookResult()

            peer_id = self._extract_peer_id(message)
            if peer_id is None:
                log("mention_notifier: could not determine dialog id, skipping reply")
                return HookResult()

            reply_text = self.get_setting("reply_text", "Я сейчас недоступен, отвечу позже!")
            msg_id = getattr(message, "id", None)

            log(f"mention_notifier: mention detected in dialog {peer_id}, replying")
            send_text(peer_id, reply_text, replyToMsg=msg_id)

        except Exception as e:
            log(f"mention_notifier error: {e}")

        return HookResult()

    def _extract_peer_id(self, message):
        try:
            return MessageObject.getDialogId(message)
        except Exception as e:
            log(f"mention_notifier: MessageObject.getDialogId failed: {e}")
            return None
`,
  },
  // <-- добавляй новые примеры сюда через запятую, по образцу выше
];

module.exports = { EXAMPLES };
