# Onkyo eISCP Protocol — Input Switching & Extended Control

## Overview

Onkyo receivers expose a proprietary protocol called **eISCP** (Integra Serial Control Protocol over Ethernet) on **TCP port 60128**. This is separate from DLNA/UPnP (port 8888) and provides low-level control over the receiver including input selection, power, volume, and audio modes.

## Network Details

- **Protocol**: TCP
- **Port**: 60128
- **Device**: Onkyo TX-NR555 at `192.168.1.95`
- **Python library**: `onkyo-eiscp` (PyPI: `eiscp`)

## Use Case: Restore Input After DLNA Cast

When MusicSeeker starts DLNA cast, the Onkyo automatically switches to NET input. After stopping cast, we want to restore the previous input (e.g. TV/CBL).

### Flow
1. **Before cast**: Query current input via `SLIQSTN` → save response (e.g. `SLI01` = CBL/SAT)
2. **Cast starts**: Onkyo auto-switches to NET (`SLI26`)
3. **Cast stops**: Send `SLI01` to restore original input

## Common eISCP Commands

### Input Selector (SLI)
| Command | Input |
|---------|-------|
| `SLI00` | VIDEO1 (VCR/DVR) |
| `SLI01` | VIDEO2 (CBL/SAT) |
| `SLI02` | VIDEO3 (GAME) |
| `SLI03` | VIDEO4 (AUX) |
| `SLI05` | VIDEO5 (PC) |
| `SLI10` | BD/DVD |
| `SLI20` | TAPE |
| `SLI22` | PHONO |
| `SLI23` | CD |
| `SLI24` | FM |
| `SLI25` | AM |
| `SLI26` | TUNER |
| `SLI27` | MUSIC SERVER (DLNA) |
| `SLI28` | INTERNET RADIO |
| `SLI29` | USB (front) |
| `SLI2B` | NETWORK |
| `SLI2E` | BLUETOOTH |
| `SLIQSTN` | Query current input |

### Power (PWR)
| Command | Action |
|---------|--------|
| `PWR01` | Power ON |
| `PWR00` | Power OFF (standby) |
| `PWRQSTN` | Query power state |

### Volume (MVL)
| Command | Action |
|---------|--------|
| `MVL{hex}` | Set volume (00-64 hex = 0-100) |
| `MVLUP` | Volume up |
| `MVLDOWN` | Volume down |
| `MVLQSTN` | Query volume |

### Muting (AMT)
| Command | Action |
|---------|--------|
| `AMT01` | Mute ON |
| `AMT00` | Mute OFF |
| `AMTTG` | Toggle mute |

## eISCP Packet Format

```
"ISCP" + header (16 bytes) + "!1" + command + "\r"
```

Header contains:
- 4 bytes: "ISCP"
- 4 bytes: header size (16, big-endian)
- 4 bytes: data size (big-endian)
- 1 byte: version (0x01)
- 3 bytes: reserved (0x00)

## Python Example (using eiscp library)

```python
import eiscp

# Connect to receiver
receiver = eiscp.eISCP('192.168.1.95')

# Query current input
current = receiver.command('input-selector', 'query')
print(f"Current input: {current}")  # e.g. ('input-selector', ('video2',))

# Switch to specific input
receiver.command('input-selector', 'video2')  # CBL/SAT

# Raw command
receiver.raw('SLI01')  # Same as above

receiver.disconnect()
```

## Async Python Example (raw TCP)

```python
import asyncio
import struct

async def eiscp_command(host, command):
    """Send eISCP command to Onkyo receiver."""
    # Build packet
    iscp_msg = f"!1{command}\r"
    header = b"ISCP"
    header += struct.pack(">I", 16)  # header size
    header += struct.pack(">I", len(iscp_msg))  # data size
    header += b"\x01\x00\x00\x00"  # version + reserved

    reader, writer = await asyncio.open_connection(host, 60128)
    writer.write(header + iscp_msg.encode())
    await writer.drain()

    # Read response
    resp_header = await reader.read(16)
    data_size = struct.unpack(">I", resp_header[8:12])[0]
    resp_data = await reader.read(data_size)

    writer.close()
    await writer.wait_closed()

    # Parse response: strip "!1" prefix and "\r\n" suffix
    return resp_data.decode().strip("!1\r\n\x1a")

# Usage:
# current_input = await eiscp_command("192.168.1.95", "SLIQSTN")
# await eiscp_command("192.168.1.95", "SLI01")  # switch to CBL/SAT
```

## Implementation Notes

- **No additional dependency needed** if using raw TCP (asyncio sockets)
- `eiscp` PyPI package available but adds dependency; raw TCP is ~20 lines
- Receiver responds within ~100ms
- Multiple commands can be sent on same connection
- Connection can be kept open for monitoring state changes
- Receiver broadcasts state changes to all connected clients

## References

- [onkyo-eiscp GitHub](https://github.com/miracle2k/onkyo-eiscp)
- [Onkyo ISCP Protocol Documentation](https://www.interlinkelectronics.com/assets/pdf/ISCP-V1.26_AV-Receiver-2013.xls)
- [eISCP protocol reverse engineering](https://tom.weblog.am/2010/12/onkyo-network-remote-protocol/)
