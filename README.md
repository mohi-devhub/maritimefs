# MaritimeFS

**Work with your Maritime agents without leaving VS Code.** Open an agent's persistent files in Explorer, edit them in the native editor, run a one-shot command, and inspect recent logs.

[Install the pre-release](https://marketplace.visualstudio.com/items?itemName=mohi-devhub.maritimefs) · [Get help](SUPPORT.md) · [MIT license](LICENSE)

## See it in action

A 59-second demo using a real agent and synthetic ticket data. It edits a remote routing file, saves it, then checks the result with a command.

https://github.com/user-attachments/assets/470ec192-ec44-4f51-a76c-b501260bbe18

## Get started

You need desktop VS Code 1.105 or newer, an existing Maritime agent, and a personal [Maritime API key](https://maritime.sh/settings/api-keys) with access to Agents. Command execution also needs the appropriate key scope.

1. Install [MaritimeFS from the Marketplace](https://marketplace.visualstudio.com/items?itemName=mohi-devhub.maritimefs) and select **Install Pre-Release**.
2. Open the **Maritime** view in the Activity Bar, choose **Connect Account**, and enter your key. VS Code stores it in SecretStorage.
3. Select an agent's **Files** action to open its persistent volume in Explorer. Opening a sleeping agent asks for confirmation.
4. Edit a file and save normally with **Cmd+S** or **Ctrl+S**. Use **Refresh Remote Files** to see changes made elsewhere.

If VS Code restarts its Extension Host while adding the first workspace folder, open the agent workspace again. Your saved key can be restored; file access stays locked until you explicitly reopen it.

## What it does

- **Native files:** Browse, create, rename, delete, and save files in a case-sensitive `maritime://` workspace.
- **Agent controls:** See account-visible agents and their status; wake, sleep, restart, or refresh with confirmation where appropriate.
- **Commands and logs:** Submit a JSON argument array such as `["pwd"]` and view its output, or inspect recent historical logs in VS Code Output Channels.

MaritimeFS is a virtual filesystem, not Remote SSH. The command runner is non-interactive and runs in the agent's default working directory, which may differ from its persistent volume.

## Current limits

- Saves check fresh remote bytes for conflicts, but Maritime has no documented atomic conditional write. Another writer can still change a file between the check and upload.
- Files are limited to 8 MiB. Changes made outside VS Code need a manual refresh. Cold wakes and API response times affect speed.
- Use trusted agent volumes: the API does not expose reliable canonical symlink metadata. A sleep between the status check and a file request may still wake the agent.
- There is no remote extension host, interactive terminal, debugger adapter, or Computers integration. Cursor and Windows have not been verified for this pre-release.

The extension uses the official Maritime TypeScript SDK, stores keys only in VS Code SecretStorage, and does not collect telemetry. It is an independent community project, unaffiliated with Maritime. See [security details](docs/security.md), [development](docs/development.md), and the [changelog](CHANGELOG.md).
