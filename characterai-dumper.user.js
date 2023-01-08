// ==UserScript==
// @name        CharacterAI Dumper
// @namespace   Violentmonkey Scripts
// @match       https://beta.character.ai/*
// @grant       none
// @version     1.4
// @author      0x000011b
// @description Allows downloading saved chat messages and character definitions from CharacterAI.
// @downloadURL https://github.com/0x000011b/characterai-dumper/raw/master/characterai-dumper.user.js
// @updateURL   https://github.com/0x000011b/characterai-dumper/raw/master/characterai-dumper.user.js
// ==/UserScript==

const log = (firstArg, ...remainingArgs) =>
  console.log(`[CharacterAI Dumper v1.4] ${firstArg}`, ...remainingArgs);
log.error = (firstArg, ...remainingArgs) =>
  console.error(`[CharacterAI Dumper v1.4] ${firstArg}`, ...remainingArgs);

// Endpoints to intercept.
const CHARACTER_INFO_URL = "https://beta.character.ai/chat/character/info/";
const CHARACTER_EXTRA_INFO_URL = "https://beta.character.ai/chat/character/";
const CHARACTER_HISTORIES_URL =
  "https://beta.character.ai/chat/character/histories/";

/** Maps a character's identifier to their basic info + chat histories. */
const characterToSavedDataMap = {};

/** Creates the "Download" link on the "View Saved Chats" page. */
const addDownloadLinkInSavedChats = (dataString, filename) => {
  // Don't create duplicate links.
  if (document.getElementById("injected-chat-dl-link")) {
    return;
  }

  // We want to add a link next to the "your past conversations with XXX" text.
  const suspectedElements = document.getElementsByClassName("home-sec-header");
  for (const element of suspectedElements) {
    if (!element.textContent.includes("Your Past Conversations with")) {
      continue;
    }

    const dataBlob = new Blob([dataString], { type: "text/plain" });
    const downloadLink = document.createElement("a");
    downloadLink.id = "injected-chat-dl-link";
    downloadLink.textContent = "Download";
    downloadLink.href = URL.createObjectURL(dataBlob);
    downloadLink.download = filename;
    downloadLink.style = "padding-left: 8px";
    element.appendChild(downloadLink);
  }
};

/** Creates the "Download" link in the "Character Editor" page. */
const addDownloadLinkInCharacterEditor = (
  dataString,
  filename,
  characterName
) => {
  if (document.getElementById("injected-character-info-dl-link")) {
    return;
  }

  const suspectedElements = document.querySelectorAll(
    "div.p-0.m-1.mb-3.border.rounded.m-1"
  );
  for (const element of suspectedElements) {
    if (!element.textContent.includes(characterName)) {
      continue;
    }

    const dataBlob = new Blob([dataString], { type: "text/plain" });
    const downloadLink = document.createElement("a");
    downloadLink.id = "injected-character-info-dl-link";
    downloadLink.textContent = "Download";
    downloadLink.href = URL.createObjectURL(dataBlob);
    downloadLink.download = filename;
    downloadLink.style = "padding-left: 66px";
    element.appendChild(downloadLink);
  }
};

/** Escapes a string so it can be used inside a regex. */
const escapeStringForRegExp = (stringToGoIntoTheRegex) => {
  return stringToGoIntoTheRegex.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
};

/** Takes in chat histories and anonymizes them. */
const anonymizeHistories = (histories) => {
  const namesToReplace = new Set();

  for (const history of histories.histories) {
    for (const msg of history.msgs) {
      if (msg.src.is_human) {
        // First, we save the original name so we can search for it and redact
        // it in the messages.
        namesToReplace.add(msg.src.user.username);
        namesToReplace.add(msg.src.user.first_name);
        namesToReplace.add(msg.src.user.account.name);
        namesToReplace.add(msg.src.user.name);
        namesToReplace.add(msg.src.name);
        namesToReplace.add(msg.display_name);

        // Then, we anonymize `src` (since the source is the human).
        msg.src.user.username = "[USERNAME_REDACTED]";
        msg.src.user.first_name = "[FIRST_NAME_REDACTED]";
        msg.src.user.account.name = "[ACCOUNT_NAME_REDACTED]";
        msg.src.user.name = "[NAME_REDACTED]";
        msg.src.name = "[NAME_REDACTED]";
        msg.display_name = "[DISPLAY_NAME_REDACTED]";
      } else {
        // Same logic as above.
        namesToReplace.add(msg.tgt.user.username);
        namesToReplace.add(msg.tgt.user.first_name);
        namesToReplace.add(msg.tgt.user.account.name);
        namesToReplace.add(msg.tgt.user.name);
        namesToReplace.add(msg.tgt.name);

        // Need to anonymize `tgt`.
        msg.tgt.user.username = "[USERNAME_REDACTED]";
        msg.tgt.user.first_name = "[FIRST_NAME_REDACTED]";
        msg.tgt.user.account.name = "[ACCOUNT_NAME_REDACTED]";
        msg.tgt.user.name = "[NAME_REDACTED]";
        msg.tgt.name = "[NAME_REDACTED]";

        // Now, since this is a bot message, there's a chance that the bot
        // uttered the user's name, so let's replace that inside the message
        // text.
        namesToReplace.forEach((nameToReplace) => {
          if (!nameToReplace) {
            return;
          }

          const replacementRegex = new RegExp(
            "\\b" + escapeStringForRegExp(nameToReplace) + "\\b",
            "g"
          );
          msg.text = msg.text.replace(
            replacementRegex,
            "[NAME_IN_MESSAGE_REDACTED]"
          );
        });
      }
    }

    // And just being extra paranoid: by the time we've gone through both user
    // _and_ bot messages, we might've seen more names to redact, so let's go
    // back to the first message and attempt to redact it again just in case we
    // have new names.
    if (history.msgs.length) {
      namesToReplace.forEach((nameToReplace) => {
        if (!nameToReplace) {
          return;
        }

        const replacementRegex = new RegExp(
          "\\b" + escapeStringForRegExp(nameToReplace) + "\\b",
          "g"
        );
        history.msgs[0].text = history.msgs[0].text.replace(
          replacementRegex,
          "[NAME_IN_MESSAGE_REDACTED]"
        );
      });
    }
  }

  // This was modified in-place, but we return it here for simplicity at the
  // call site even though it's technically useless (and slightly misleading).
  return histories;
};

/** Configures XHook to intercept the endpoints we care about. */
const configureXHookIntercepts = () => {
  xhook.after((_req, res) => {
    try {
      const endpoint = res.finalUrl;
      if (
        endpoint !== CHARACTER_INFO_URL &&
        endpoint !== CHARACTER_HISTORIES_URL &&
        endpoint !== CHARACTER_EXTRA_INFO_URL
      ) {
        // We don't care about other endpoints.
        return;
      }

      const data = JSON.parse(res.data);
      let characterIdentifier;

      if (res.finalUrl === CHARACTER_INFO_URL) {
        characterIdentifier = data.character.name.trim();
        data.character.user__username = "[BOT_CREATOR_NAME_REDACTED]";

        log(`Got character info for ${characterIdentifier}, caching...`);

        if (!characterToSavedDataMap[characterIdentifier]) {
          characterToSavedDataMap[characterIdentifier] = {};
        }
        characterToSavedDataMap[characterIdentifier].info = data;
      } else if (res.finalUrl === CHARACTER_HISTORIES_URL) {
        characterIdentifier = data.histories[0].msgs[0].src.name.trim();
        log(`Got chat histories for ${characterIdentifier}, caching...`);

        if (!characterToSavedDataMap[characterIdentifier]) {
          characterToSavedDataMap[characterIdentifier] = {};
        }
        characterToSavedDataMap[characterIdentifier].histories =
          anonymizeHistories(data);
      } else if (res.finalUrl === CHARACTER_EXTRA_INFO_URL) {
        characterIdentifier = data.character.name.trim();
        data.user__username = "[BOT_CREATOR_NAME_REDACTED]";
        data.character.user__username = "[BOT_CREATOR_NAME_REDACTED]";

        log(
          `Got definitions for ${characterIdentifier}, creating download link.`
        );

        log("If it doesn't show up, here's the data:", JSON.stringify(data));

        // The character editor returns all the info we want in a single
        // request, so we can just create the button and return from this
        // function already.
        setTimeout(
          () =>
            addDownloadLinkInCharacterEditor(
              JSON.stringify(data),
              `${characterIdentifier} (Definitions).json`,
              characterIdentifier
            ),
          2000
        );
        return;
      }

      const currentCharacter = characterToSavedDataMap[characterIdentifier];
      if (currentCharacter.info && currentCharacter.histories) {
        // We have all the downloadable data for this character, and we're on the
        // correct page. Create the download link.
        log(
          `Got all the data for ${characterIdentifier}, creating download link.`
        );

        log(
          "If it doesn't show up, here's the data:",
          JSON.stringify(currentCharacter)
        );

        // For some reason, the link doesn't get added if we call this right now,
        // so we wait a little while instead. Probably React re-render fuckery.
        setTimeout(
          () =>
            addDownloadLinkInSavedChats(
              JSON.stringify(currentCharacter),
              `${characterIdentifier}.json`
            ),
          2000
        );
      }
    } catch (err) {
      log.error("ERROR:", err);
    }
  });
};

// This is where XHook (lib for intercepting XHR/AJAX calls) gets injected into
// the document, and once it gets properly parsed it'll call out to the setup
// function.
//
// Copy-pasted and slightly adapted from: https://stackoverflow.com/a/8578840
log("Injecting XHook to intercept XHR/AJAX calls.");
(function (document, elementTagName, elementTagId) {
  var js,
    fjs = document.getElementsByTagName(elementTagName)[0];
  if (document.getElementById(elementTagId)) {
    return;
  }
  js = document.createElement(elementTagName);
  js.id = elementTagId;
  js.onload = function () {
    log("Done! Configuring intercepts.");
    configureXHookIntercepts();
  };
  // Link to hosted version taken from the official repo:
  // https://github.com/jpillora/xhook
  js.src = "https://jpillora.com/xhook/dist/xhook.min.js";
  fjs.parentNode.insertBefore(js, fjs);
})(document, "script", "xhook");
