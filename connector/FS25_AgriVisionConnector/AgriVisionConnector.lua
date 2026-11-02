--[[
  AgriVision Connector v0.1 — dedicated-server snapshot writer.

  Primary transport: files under modSettings/FS25_AgriVisionConnector/
  HTTPS from Lua is NOT required and not used here (sandbox / performance open).

  Contract: docs/CONNECTOR-CONTRACT.md

  This file uses only widely attested Engine entry points where possible.
  Farm balance / name reads are guarded; missing values are omitted (UI: unavailable).
]]

AgriVisionConnector = {}
AgriVisionConnector.MOD_NAME = "FS25_AgriVisionConnector"
AgriVisionConnector.VERSION = "0.1.4.0"
AgriVisionConnector.SCHEMA = "1"
AgriVisionConnector.TICK_MS = 5000
AgriVisionConnector.HELLO_EVERY_MS = 60000
AgriVisionConnector.FULL_VEHICLE_EVERY_MS = 60000
AgriVisionConnector.WAIT_LOG_EVERY_MS = 30000
AgriVisionConnector.ICON_RETRY_EVERY_MS = 600000

local function log(msg)
    print(string.format("AgriVisionConnector: %s", tostring(msg)))
end

local function utcNow()
    -- Engine date helpers vary; ISO-ish fallback for file metadata.
    if getDate ~= nil then
        return tostring(getDate("%Y-%m-%dT%H:%M:%SZ"))
    end
    return "unknown"
end

local function ensureDir(path)
    if createFolder ~= nil then
        createFolder(path)
    end
end

function AgriVisionConnector:init()
    if g_server == nil then
        log("not a server — idle")
        self.active = false
        return
    end

    self.active = true
    self.generation = 0
    self.tickAccumMs = 0
    self.fullAccumMs = 0
    self.helloAccumMs = 0
    self.waitLogAccumMs = 0
    self.iconRetryAccumMs = 0
    self.lastFullVehiclesAt = 0
    self.processedCommands = {}
    self.lastVehiclesFingerprint = nil
    self.lastIconsFingerprint = nil

    local profile = getUserProfileAppPath()
    self.baseDir = profile .. "modSettings/" .. self.MOD_NAME .. "/"
    self.stateDir = self.baseDir .. "state/"
    self.iconsDir = self.baseDir .. "icons/"
    self.storeIconsDir = self.iconsDir .. "store/"
    self.fruitsIconsDir = self.iconsDir .. "fruits/"
    self.modIconsDir = self.iconsDir .. "mods/"
    self.pendingStoreIcons = {}
    self.copiedStorePaths = {}
    self.failedStoreIcons = {}
    self.loggedStoreIconFails = {}
    -- Vehicles/store icons must wait until the mission has spawned the fleet.
    -- Mod load runs before the savegame — scanning here always yields unique=0.
    self.vehiclesPrimed = false

    ensureDir(profile .. "modSettings/")
    ensureDir(self.baseDir)
    ensureDir(self.stateDir)
    ensureDir(self.iconsDir)
    ensureDir(self.storeIconsDir)
    ensureDir(self.fruitsIconsDir)
    -- mod icons deferred (needed later for mod list UI, not vehicle overview)

    -- Drop empty leftover command.xml so the Engine does not spam
    -- "Trying to open empty xml file" every tick before the dashboard writes one.
    self:deletePath(self.baseDir .. "command.xml")

    log(
        string.format(
            "active, baseDir=%s copyFile=%s fileExists=%s getFileSize=%s deleteFile=%s XMLFile=%s",
            self.baseDir,
            tostring(copyFile ~= nil),
            tostring(fileExists ~= nil),
            tostring(getFileSize ~= nil),
            tostring(deleteFile ~= nil),
            tostring(XMLFile ~= nil)
        )
    )
    self:writeHello()
end

function AgriVisionConnector:nextGeneration()
    self.generation = self.generation + 1
    return self.generation
end

function AgriVisionConnector:xmlEscape(value)
    if value == nil then
        return ""
    end
    local s = tostring(value)
    s = string.gsub(s, "&", "&amp;")
    s = string.gsub(s, "<", "&lt;")
    s = string.gsub(s, ">", "&gt;")
    s = string.gsub(s, '"', "&quot;")
    return s
end

function AgriVisionConnector:writeTextFile(path, body)
    -- Dedicated-server sandbox: io.open works, os.* is often nil (crash: os.remove).
    if io == nil or io.open == nil then
        log("no io.open — hello/vehicles not written")
        return false
    end
    local f = io.open(path, "w")
    if f == nil then
        log("cannot write " .. path)
        return false
    end
    f:write(body)
    f:close()
    return true
end

function AgriVisionConnector:collectFarmsXml()
    local parts = { "<farms>" }
    if g_farmManager ~= nil and g_farmManager.getFarms ~= nil then
        local farms = g_farmManager:getFarms()
        if farms ~= nil then
            for _, farm in pairs(farms) do
                if farm ~= nil and farm.farmId ~= nil and farm.farmId > 0 then
                    local attrs = string.format(' id="%s"', self:xmlEscape(farm.farmId))
                    if farm.name ~= nil and farm.name ~= "" then
                        attrs = attrs .. string.format(' name="%s"', self:xmlEscape(farm.name))
                    end
                    if farm.getBalance ~= nil then
                        local ok, balance = pcall(function()
                            return farm:getBalance()
                        end)
                        if ok and type(balance) == "number" then
                            attrs = attrs .. string.format(' money="%s"', self:xmlEscape(balance))
                        end
                    end
                    table.insert(parts, string.format("    <farm%s />", attrs))
                end
            end
        end
    end
    table.insert(parts, "</farms>")
    return table.concat(parts, "\n")
end

function AgriVisionConnector:writeHello()
    local gen = self:nextGeneration()
    local gameTime = 0
    if g_currentMission ~= nil and g_currentMission.environment ~= nil and g_currentMission.environment.dayTime ~= nil then
        gameTime = g_currentMission.environment.dayTime
    end
    local body = string.format(
        [[<?xml version="1.0" encoding="utf-8"?>
<agrivisionConnector version="%s" schema="%s" generation="%s" writtenAtUtc="%s" gameTimeMs="%s">
%s
</agrivisionConnector>
]],
        self:xmlEscape(self.VERSION),
        self.SCHEMA,
        tostring(gen),
        self:xmlEscape(utcNow()),
        self:xmlEscape(gameTime),
        self:collectFarmsXml()
    )
    self:writeTextFile(self.baseDir .. "hello.xml", body)
end

function AgriVisionConnector:vehicleWorldPos(vehicle)
    if vehicle == nil then
        return nil, nil, nil
    end
    local ok, x, y, z = pcall(function()
        if vehicle.rootNode ~= nil and getWorldTranslation ~= nil then
            return getWorldTranslation(vehicle.rootNode)
        end
        if vehicle.components ~= nil and vehicle.components[1] ~= nil and vehicle.components[1].node ~= nil and getWorldTranslation ~= nil then
            return getWorldTranslation(vehicle.components[1].node)
        end
        return nil, nil, nil
    end)
    if ok then
        return x, y, z
    end
    return nil, nil, nil
end

function AgriVisionConnector:collectVehiclesFullXml()
    local parts = {}
    local identityParts = {}
    self.pendingStoreIcons = {}
    local vehiclesTable = self:missionVehicles()
    if vehiclesTable == nil then
        return "    <!-- vehicle list unavailable on this build -->\n", ""
    end

    local count = 0
    for _, vehicle in pairs(vehiclesTable) do
        if vehicle ~= nil then
            local farmId = nil
            if vehicle.getOwnerFarmId ~= nil then
                local ok, id = pcall(function()
                    return vehicle:getOwnerFarmId()
                end)
                if ok and type(id) == "number" and id > 0 then
                    farmId = id
                end
            elseif type(vehicle.ownerFarmId) == "number" and vehicle.ownerFarmId > 0 then
                farmId = vehicle.ownerFarmId
            end

            local uniqueId = nil
            if vehicle.getUniqueId ~= nil then
                local ok, uid = pcall(function()
                    return vehicle:getUniqueId()
                end)
                if ok and uid ~= nil and tostring(uid) ~= "" then
                    uniqueId = tostring(uid)
                end
            elseif vehicle.uniqueId ~= nil then
                uniqueId = tostring(vehicle.uniqueId)
            end

            local filename = vehicle.configFileName or vehicle.xmlFilename or ""
            local name = ""
            if vehicle.getName ~= nil then
                local ok, n = pcall(function()
                    return vehicle:getName()
                end)
                if ok and n ~= nil then
                    name = tostring(n)
                end
            end
            if name == "" and vehicle.name ~= nil then
                name = tostring(vehicle.name)
            end

            local operatingTime = nil
            if type(vehicle.operatingTime) == "number" then
                -- Engine stores ms; contract expects hours.
                operatingTime = vehicle.operatingTime / 3600000
            end

            local modKey = self:modKeyFromFilename(filename)
            local storeKey = self:storeKeyFromFilename(filename)
            local brand = self:vehicleBrand(vehicle, filename)
            local fuel, fuelCapacity, defLevel, defCapacity = self:vehicleFluids(vehicle)
            local wear = self:vehicleWear(vehicle)
            local plate = self:vehiclePlate(vehicle)
            local imageSrc = self:vehicleStoreImage(vehicle, filename)
            if storeKey ~= nil and imageSrc ~= nil and self.pendingStoreIcons[storeKey] == nil then
                self.pendingStoreIcons[storeKey] = {
                    src = imageSrc,
                    filename = filename,
                }
            end

            local x, y, z = self:vehicleWorldPos(vehicle)
            local attrs = {}
            local identity = {}
            if uniqueId ~= nil then
                table.insert(attrs, string.format('uniqueId="%s"', self:xmlEscape(uniqueId)))
                table.insert(identity, "u=" .. tostring(uniqueId))
            end
            if filename ~= "" then
                table.insert(attrs, string.format('filename="%s"', self:xmlEscape(filename)))
                table.insert(identity, "f=" .. tostring(filename))
            end
            if farmId ~= nil then
                table.insert(attrs, string.format('farmId="%s"', self:xmlEscape(farmId)))
                table.insert(identity, "farm=" .. tostring(farmId))
            end
            if name ~= "" then
                table.insert(attrs, string.format('name="%s"', self:xmlEscape(name)))
                table.insert(identity, "n=" .. tostring(name))
            end
            if storeKey ~= nil then
                table.insert(attrs, string.format('storeKey="%s"', self:xmlEscape(storeKey)))
                table.insert(identity, "sk=" .. tostring(storeKey))
            end
            if modKey ~= nil then
                table.insert(attrs, string.format('modKey="%s"', self:xmlEscape(modKey)))
                table.insert(identity, "mk=" .. tostring(modKey))
            end
            if brand ~= nil and brand ~= "" then
                table.insert(attrs, string.format('brand="%s"', self:xmlEscape(brand)))
                table.insert(identity, "b=" .. tostring(brand))
            end
            if fuel ~= nil and fuelCapacity ~= nil and fuelCapacity > 0 then
                table.insert(attrs, string.format('fuel="%.0f" fuelCapacity="%.0f"', fuel, fuelCapacity))
                table.insert(identity, "fu=" .. tostring(math.floor(fuel + 0.5)))
            end
            if defLevel ~= nil and defCapacity ~= nil and defCapacity > 0 then
                table.insert(attrs, string.format('defLevel="%.0f" defCapacity="%.0f"', defLevel, defCapacity))
                table.insert(identity, "df=" .. tostring(math.floor(defLevel + 0.5)))
            end
            if wear ~= nil then
                table.insert(attrs, string.format('wear="%d"', wear))
                table.insert(identity, "w=" .. tostring(wear))
            end
            if plate ~= nil and plate ~= "" then
                table.insert(attrs, string.format('plate="%s"', self:xmlEscape(plate)))
                table.insert(identity, "p=" .. tostring(plate))
            end
            if operatingTime ~= nil then
                table.insert(attrs, string.format('operatingTime="%.2f"', operatingTime))
            end
            if x ~= nil and z ~= nil then
                table.insert(attrs, string.format('x="%.2f" y="%.2f" z="%.2f"', x, y or 0, z))
            end
            if #attrs > 0 then
                table.insert(parts, string.format("  <vehicle %s />\n", table.concat(attrs, " ")))
                table.insert(identityParts, table.concat(identity, "|"))
                count = count + 1
            end
        end
    end

    if count == 0 then
        return "    <!-- no vehicles enumerated -->\n", ""
    end
    table.sort(identityParts)
    return table.concat(parts, ""), table.concat(identityParts, "\n")
end

function AgriVisionConnector:writeVehiclesFull()
    local vehiclesXml, fingerprint = self:collectVehiclesFullXml()
    local pendingCount = 0
    for _ in pairs(self.pendingStoreIcons or {}) do
        pendingCount = pendingCount + 1
    end
    local changed = fingerprint ~= self.lastVehiclesFingerprint
    if changed then
        local gen = self:nextGeneration()
        local body = string.format(
            [[<?xml version="1.0" encoding="utf-8"?>
<vehiclesFull schema="%s" generation="%s" writtenAtUtc="%s" kind="full">
%s</vehiclesFull>
]],
            self.SCHEMA,
            tostring(gen),
            self:xmlEscape(utcNow()),
            vehiclesXml
        )
        self:writeTextFile(self.stateDir .. "vehicles_full.xml", body)
        self.lastVehiclesFingerprint = fingerprint
        log(string.format("vehicles_full written storeIconCandidates=%s", tostring(pendingCount)))
    end
    self:writeStoreIconsManifest(changed)
    self.lastFullVehiclesAt = g_time or 0
end

function AgriVisionConnector:modKeyFromFilename(filename)
    if filename == nil or filename == "" then
        return nil
    end
    local path = tostring(filename):gsub("\\", "/")
    local key = string.match(path, "%$moddir%$([^/]+)")
    if key == nil then
        key = string.match(path, "/(FS25_[^/]+)/")
    end
    if key == nil then
        key = string.match(path, "^(FS25_[^/]+)/")
    end
    if key == nil or key == "" then
        return nil
    end
    key = key:gsub("%.zip$", "")
    return key
end

--- Stable key for vehicle store image (type-level, shared by duplicates).
function AgriVisionConnector:storeKeyFromFilename(filename)
    if filename == nil or filename == "" then
        return nil
    end
    local path = tostring(filename):gsub("\\", "/"):lower()
    path = path:gsub("%$moddir%$", "mod/")
    path = path:gsub("%.xml$", "")
    path = path:gsub("[^a-z0-9]+", "_"):gsub("^_", ""):gsub("_$", "")
    if path == "" then
        return nil
    end
    if #path > 96 then
        path = path:sub(-96)
    end
    return path
end

--- Expand a store-image path into Engine-resolvable variants (folder, zip, dds).
--- Dedicated hosts often ship mods as .zip only; PNG folder paths fail while
--- ModName.zip/…/store_x.dds succeeds via copyFile.
function AgriVisionConnector:buildStoreImageCandidates(raw)
    local out = {}
    local seen = {}
    local function add(path)
        if path == nil then
            return
        end
        local p = tostring(path):gsub("\\", "/")
        if p == "" or seen[p] then
            return
        end
        seen[p] = true
        table.insert(out, p)
    end
    local function addWithAltExt(path)
        add(path)
        if path == nil then
            return
        end
        local p = tostring(path)
        local lower = string.lower(p)
        if string.find(lower, "%.png$") then
            add((string.gsub(p, "[Pp][Nn][Gg]$", "dds")))
        elseif string.find(lower, "%.dds$") then
            add((string.gsub(p, "[Dd][Dd][Ss]$", "png")))
        end
    end
    local function addZipVariant(path)
        if path == nil then
            return
        end
        local p = tostring(path):gsub("\\", "/")
        -- …/mods/ModName/rest → …/mods/ModName.zip/rest
        local before, modName, rest = string.match(p, "^(.-/mods/)([^/]+)/(.+)$")
        if before ~= nil and modName ~= nil and rest ~= nil and not string.find(modName, "%.zip$") then
            addWithAltExt(before .. modName .. ".zip/" .. rest)
        end
    end

    if raw == nil then
        return out
    end
    local path = tostring(raw)
    if path == "" then
        return out
    end
    if NetworkUtil ~= nil and NetworkUtil.convertFromNetworkFilename ~= nil then
        local ok, converted = pcall(function()
            return NetworkUtil.convertFromNetworkFilename(path)
        end)
        if ok and converted ~= nil and tostring(converted) ~= "" then
            path = tostring(converted)
        end
    end

    local seeds = { path }

    if Utils ~= nil and Utils.getFilename ~= nil then
        local ok, resolved = pcall(function()
            return Utils.getFilename(path, "")
        end)
        if ok and resolved ~= nil and tostring(resolved) ~= "" then
            table.insert(seeds, tostring(resolved))
        end
    end

    local modName, modRest = string.match(path, "^%$moddir%$([^/]+)/(.+)$")
    if modName ~= nil and modRest ~= nil then
        local profile = nil
        if getUserProfileAppPath ~= nil then
            local ok, p = pcall(getUserProfileAppPath)
            if ok then
                profile = p
            end
        end
        if profile ~= nil then
            table.insert(seeds, profile .. "mods/" .. modName .. "/" .. modRest)
            table.insert(seeds, profile .. "mods/" .. modName .. ".zip/" .. modRest)
        end
        if g_modNameToDirectory ~= nil and g_modNameToDirectory[modName] ~= nil then
            table.insert(seeds, g_modNameToDirectory[modName] .. modRest)
        end
    end

    local stripped = path
    if string.sub(stripped, 1, 6) == "$data/" then
        stripped = "data/" .. string.sub(stripped, 7)
    elseif string.sub(stripped, 1, 5) == "$data" then
        stripped = "data" .. string.sub(stripped, 6)
    end
    if getAppBasePath ~= nil then
        local ok, base = pcall(getAppBasePath)
        if ok and base ~= nil and tostring(base) ~= "" then
            table.insert(seeds, tostring(base) .. stripped)
            if stripped ~= path then
                table.insert(seeds, tostring(base) .. path)
            end
        end
    end

    for _, seed in ipairs(seeds) do
        addWithAltExt(seed)
        addZipVariant(seed)
        -- zip + alt ext (png↔dds) for the zip form
        local p = tostring(seed):gsub("\\", "/")
        local before, name, rest = string.match(p, "^(.-/mods/)([^/]+)/(.+)$")
        if before ~= nil and name ~= nil and rest ~= nil and not string.find(name, "%.zip$") then
            addWithAltExt(before .. name .. ".zip/" .. rest)
        end
    end

    -- Prefer DDS first (copyFile reliably yields ~262KB; PNG often leaves 0-byte stubs).
    table.sort(out, function(a, b)
        local ad = self:iconExtFromPath(a) == "dds"
        local bd = self:iconExtFromPath(b) == "dds"
        if ad ~= bd then
            return ad
        end
        return a < b
    end)
    return out
end

function AgriVisionConnector:resolveStoreImagePath(raw)
    local candidates = self:buildStoreImageCandidates(raw)
    if #candidates == 0 then
        return nil
    end
    for _, candidate in ipairs(candidates) do
        if self:fileLooksPresent(candidate) then
            return candidate
        end
    end
    -- Fallback: first DDS candidate, else first seed — copyIconFile will try.
    for _, candidate in ipairs(candidates) do
        if self:iconExtFromPath(candidate) == "dds" then
            return candidate
        end
    end
    return candidates[1]
end

function AgriVisionConnector:tryCopyStoreIcon(storeKey, rawSrc)
    local candidates = self:buildStoreImageCandidates(rawSrc)
    if #candidates == 0 then
        return false, nil, nil
    end
    -- Without getFileSize, PNG/JPG copyFile has left 0-byte stubs on this host.
    -- Only attempt DDS; backend converts if a PNG-only asset remains missing.
    local sizeKnown = getFileSize ~= nil
    for _, src in ipairs(candidates) do
        local ext = self:iconExtFromPath(src)
        if sizeKnown or ext == "dds" then
            local rel = string.format("icons/store/%s.%s", storeKey, ext)
            local dest = self.baseDir .. rel
            if self:copyIconFile(src, dest) then
                -- Drop sibling stubs (e.g. old 0-byte .png after a .dds success).
                for _, otherExt in ipairs({ "png", "dds", "jpg", "jpeg" }) do
                    if otherExt ~= ext then
                        local other = self.baseDir
                            .. string.format("icons/store/%s.%s", storeKey, otherExt)
                        if self.copiedStorePaths == nil or not self.copiedStorePaths[other] then
                            self:deletePath(other)
                        end
                    end
                end
                return true, rel, src
            end
        end
    end
    return false, nil, nil
end

function AgriVisionConnector:finiteNumber(value)
    return type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge
end

function AgriVisionConnector:fillTypeName(vehicle, index, rawType)
    if type(rawType) == "string" and rawType ~= "" then
        return string.upper(rawType)
    end
    if type(rawType) == "table" and type(rawType.name) == "string" then
        return string.upper(rawType.name)
    end
    local typeIndex = rawType
    if type(typeIndex) ~= "number" and vehicle.getFillUnitFillType ~= nil then
        local ok, value = pcall(function()
            return vehicle:getFillUnitFillType(index)
        end)
        if ok then
            if type(value) == "string" then
                return string.upper(value)
            end
            if type(value) == "table" and type(value.name) == "string" then
                return string.upper(value.name)
            end
            typeIndex = value
        end
    end
    if type(typeIndex) == "number" and g_fillTypeManager ~= nil then
        if g_fillTypeManager.getFillTypeNameByIndex ~= nil then
            local ok, name = pcall(function()
                return g_fillTypeManager:getFillTypeNameByIndex(typeIndex)
            end)
            if ok and type(name) == "string" and name ~= "" then
                return string.upper(name)
            end
        end
        if g_fillTypeManager.getFillTypeByIndex ~= nil then
            local ok, fillType = pcall(function()
                return g_fillTypeManager:getFillTypeByIndex(typeIndex)
            end)
            if ok and type(fillType) == "table" and type(fillType.name) == "string" then
                return string.upper(fillType.name)
            end
        end
    end
    if FillType ~= nil and type(typeIndex) == "number" then
        if typeIndex == FillType.DIESEL then
            return "DIESEL"
        end
        if typeIndex == FillType.DEF then
            return "DEF"
        end
        if FillType.ELECTRICCHARGE ~= nil and typeIndex == FillType.ELECTRICCHARGE then
            return "ELECTRICCHARGE"
        end
        if FillType.METHANE ~= nil and typeIndex == FillType.METHANE then
            return "METHANE"
        end
    end
    return nil
end

--- Diesel / electric / methane summed as fuel. DEF only when a real tank exists.
function AgriVisionConnector:vehicleFluids(vehicle)
    if vehicle == nil then
        return nil, nil, nil, nil
    end
    local count = 0
    local specUnits = nil
    if vehicle.spec_fillUnit ~= nil and type(vehicle.spec_fillUnit.fillUnits) == "table" then
        specUnits = vehicle.spec_fillUnit.fillUnits
        count = #specUnits
    end
    if count < 1 and vehicle.getFillUnitCount ~= nil then
        local okCount, rawCount = pcall(function()
            return vehicle:getFillUnitCount()
        end)
        if okCount and type(rawCount) == "number" then
            count = rawCount
        end
    end
    if count < 1 then
        return nil, nil, nil, nil
    end
    local fuel, fuelCapacity, defLevel, defCapacity = nil, nil, nil, nil
    local fuelNames = { DIESEL = true, ELECTRICCHARGE = true, METHANE = true }
    for index = 1, count do
        local unit = specUnits ~= nil and specUnits[index] or nil
        local typeName = self:fillTypeName(vehicle, index, unit ~= nil and unit.fillType or nil)
        local level, capacity = nil, nil
        if unit ~= nil and self:finiteNumber(unit.fillLevel) then
            level = unit.fillLevel
        elseif vehicle.getFillUnitFillLevel ~= nil then
            local okLevel, rawLevel = pcall(function()
                return vehicle:getFillUnitFillLevel(index)
            end)
            if okLevel and self:finiteNumber(rawLevel) then
                level = rawLevel
            end
        end
        if unit ~= nil and self:finiteNumber(unit.capacity) then
            capacity = unit.capacity
        elseif vehicle.getFillUnitCapacity ~= nil then
            local okCap, rawCap = pcall(function()
                return vehicle:getFillUnitCapacity(index)
            end)
            if okCap and self:finiteNumber(rawCap) then
                capacity = rawCap
            end
        end
        if typeName ~= nil and capacity ~= nil and capacity > 1 and level ~= nil then
            if typeName == "DEF" or typeName == "ADBLUE" then
                defLevel = (defLevel or 0) + level
                defCapacity = (defCapacity or 0) + capacity
            elseif fuelNames[typeName] then
                fuel = (fuel or 0) + level
                fuelCapacity = (fuelCapacity or 0) + capacity
            end
        end
    end
    return fuel, fuelCapacity, defLevel, defCapacity
end

--- Damage as percent 0–100. Nil when the vehicle has no wearable spec.
function AgriVisionConnector:vehicleWear(vehicle)
    if vehicle == nil then
        return nil
    end
    local damage = nil
    if vehicle.getDamageAmount ~= nil then
        local ok, value = pcall(function()
            return vehicle:getDamageAmount()
        end)
        if ok and self:finiteNumber(value) then
            damage = value
        end
    end
    if damage == nil and vehicle.spec_wearable ~= nil and self:finiteNumber(vehicle.spec_wearable.damage) then
        damage = vehicle.spec_wearable.damage
    end
    if damage == nil then
        return nil
    end
    if damage < 0 then
        damage = 0
    elseif damage > 1 then
        damage = 1
    end
    return math.floor(damage * 100 + 0.5)
end

function AgriVisionConnector:vehiclePlate(vehicle)
    if vehicle == nil then
        return nil
    end
    if vehicle.getLicensePlateText ~= nil then
        local ok, text = pcall(function()
            return vehicle:getLicensePlateText()
        end)
        if ok and type(text) == "string" then
            text = text:gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
            if text ~= "" then
                return text
            end
        end
    end
    local spec = vehicle.spec_licensePlates
    if spec == nil then
        return nil
    end
    if type(spec.licensePlateText) == "string" and spec.licensePlateText ~= "" then
        return spec.licensePlateText
    end
    local plates = spec.licensePlates or spec.plates
    if type(plates) ~= "table" then
        return nil
    end
    for _, plate in pairs(plates) do
        if type(plate) == "table" then
            if type(plate.charactersText) == "string" and plate.charactersText ~= "" then
                return plate.charactersText
            end
            if type(plate.characters) == "string" and plate.characters ~= "" then
                return plate.characters
            end
            if type(plate.characters) == "table" then
                local chars = {}
                for _, entry in ipairs(plate.characters) do
                    if type(entry) == "string" and entry ~= "" then
                        table.insert(chars, entry)
                    elseif type(entry) == "table" and type(entry.character) == "string" then
                        table.insert(chars, entry.character)
                    end
                end
                if #chars > 0 then
                    return table.concat(chars)
                end
            end
        end
    end
    return nil
end

function AgriVisionConnector:vehicleBrand(vehicle, filename)
    local storeItem = nil
    if vehicle ~= nil and vehicle.storeItem ~= nil then
        storeItem = vehicle.storeItem
    end
    if storeItem == nil and g_storeManager ~= nil and g_storeManager.getItemByXMLFilename ~= nil and filename ~= nil and filename ~= "" then
        local ok, item = pcall(function()
            return g_storeManager:getItemByXMLFilename(filename)
        end)
        if ok and item ~= nil then
            storeItem = item
        end
    end
    if storeItem == nil then
        return nil
    end

    local index = storeItem.brandIndex
    if g_brandManager ~= nil and g_brandManager.getBrandByIndex ~= nil and type(index) == "number" then
        local ok, brand = pcall(function()
            return g_brandManager:getBrandByIndex(index)
        end)
        if ok and brand ~= nil then
            local title = brand.title
            if type(title) == "string" and title:sub(1, 6) == "$l10n_" and g_i18n ~= nil and g_i18n.getText ~= nil then
                local okText, text = pcall(function()
                    return g_i18n:getText(title)
                end)
                if okText and type(text) == "string" and text ~= "" and text ~= title then
                    return text
                end
            end
            if type(brand.name) == "string" and brand.name ~= "" then
                return brand.name
            end
            if type(title) == "string" and title ~= "" and title:sub(1, 6) ~= "$l10n_" then
                return title
            end
        end
    end
    if type(storeItem.brand) == "string" and storeItem.brand ~= "" then
        return storeItem.brand
    end
    return nil
end

function AgriVisionConnector:vehicleStoreImage(vehicle, filename)
    local candidates = {}
    if vehicle ~= nil and vehicle.getImageFilename ~= nil then
        local ok, image = pcall(function()
            return vehicle:getImageFilename()
        end)
        if ok and image ~= nil and tostring(image) ~= "" then
            table.insert(candidates, tostring(image))
        end
    end
    if vehicle ~= nil and vehicle.storeItem ~= nil and vehicle.storeItem.imageFilename ~= nil then
        local image = tostring(vehicle.storeItem.imageFilename)
        if image ~= "" then
            table.insert(candidates, image)
        end
    end
    if g_storeManager ~= nil and g_storeManager.getItemByXMLFilename ~= nil and filename ~= nil and filename ~= "" then
        local ok, item = pcall(function()
            return g_storeManager:getItemByXMLFilename(filename)
        end)
        if ok and item ~= nil and item.imageFilename ~= nil and tostring(item.imageFilename) ~= "" then
            table.insert(candidates, tostring(item.imageFilename))
        end
    end
    for _, raw in ipairs(candidates) do
        local resolved = self:resolveStoreImagePath(raw)
        if resolved ~= nil then
            return resolved
        end
    end
    return nil
end

function AgriVisionConnector:missionVehicles()
    if g_currentMission == nil then
        return nil
    end
    local vs = g_currentMission.vehicleSystem
    if vs ~= nil then
        if vs.vehicles ~= nil then
            return vs.vehicles
        end
        -- Some builds expose vehicles only via getter.
        if vs.getVehicles ~= nil then
            local ok, list = pcall(function()
                return vs:getVehicles()
            end)
            if ok and list ~= nil then
                return list
            end
        end
    end
    if g_currentMission.vehicles ~= nil then
        return g_currentMission.vehicles
    end
    return nil
end

function AgriVisionConnector:countVehicles(vehiclesTable)
    if vehiclesTable == nil then
        return 0
    end
    local n = 0
    for _, vehicle in pairs(vehiclesTable) do
        if vehicle ~= nil then
            n = n + 1
        end
    end
    return n
end

function AgriVisionConnector:missionHasVehicles()
    return self:countVehicles(self:missionVehicles()) > 0
end

function AgriVisionConnector:missionReadyHint()
    if g_currentMission == nil then
        return "g_currentMission=nil"
    end
    local vs = g_currentMission.vehicleSystem
    if vs == nil then
        return "vehicleSystem=nil"
    end
    local n = self:countVehicles(self:missionVehicles())
    return string.format("vehicles=%s", tostring(n))
end

--- Dedicated FS25 sandbox: io.open only allows write mode ('w'). Never use io read
--- for existence or binary copy (Farmhand / GIANTS rule). Use Engine file APIs.
function AgriVisionConnector:engineFileExists(path)
    if path == nil or path == "" or fileExists == nil then
        return false
    end
    local ok, exists = pcall(fileExists, path)
    return ok and exists == true
end

function AgriVisionConnector:engineFileSize(path)
    if path == nil or path == "" or getFileSize == nil then
        return nil
    end
    local ok, size = pcall(getFileSize, path)
    if ok and type(size) == "number" then
        return size
    end
    return nil
end

function AgriVisionConnector:deletePath(path)
    if path == nil or path == "" or deleteFile == nil then
        return
    end
    pcall(deleteFile, path)
end

function AgriVisionConnector:fileLooksPresent(path)
    if not self:engineFileExists(path) then
        return false
    end
    local size = self:engineFileSize(path)
    if size ~= nil and size <= 0 then
        return false
    end
    return true
end

function AgriVisionConnector:copyIconFile(src, dest)
    if src == nil or dest == nil or src == "" or dest == "" then
        return false
    end
    if self.copiedStorePaths == nil then
        self.copiedStorePaths = {}
    end
    -- Verified this session.
    if self.copiedStorePaths[dest] then
        return true
    end
    -- Existing dest: keep it. Without getFileSize we must not delete+recopy every
    -- minute (that filled the log and hammered the disk on dedicated hosts).
    if self:fileLooksPresent(dest) then
        self.copiedStorePaths[dest] = true
        return true
    end
    -- Drop empty leftovers when we can measure size.
    if getFileSize ~= nil and self:engineFileExists(dest) then
        self:deletePath(dest)
    end
    if copyFile == nil then
        return false
    end
    local srcVisible = self:engineFileExists(src)
    local ok = pcall(function()
        copyFile(src, dest, true)
    end)
    if not ok or not self:engineFileExists(dest) then
        self:deletePath(dest)
        return false
    end
    local size = self:engineFileSize(dest)
    if size ~= nil and size <= 0 then
        self:deletePath(dest)
        return false
    end
    -- Without getFileSize, only keep if source was visible (DDS copies work).
    if size == nil and not srcVisible then
        self:deletePath(dest)
        return false
    end
    self.copiedStorePaths[dest] = true
    return true
end

function AgriVisionConnector:iconExtFromPath(path)
    local lower = string.lower(tostring(path or ""))
    if string.find(lower, "%.dds") then
        return "dds"
    end
    if string.find(lower, "%.jpe?g") then
        return "jpg"
    end
    return "png"
end

--- Vehicle store icons only (unique types in the current mission). Mod-pack icons are deferred.
--- forceWrite: rewrite the manifest even when nothing new was copied (fleet changed).
function AgriVisionConnector:writeStoreIconsManifest(forceWrite)
    ensureDir(self.storeIconsDir)
    local rows = {}
    local copiedCount = 0
    local newlyCopied = 0
    local failedCount = 0
    local pending = self.pendingStoreIcons or {}
    local failSamples = {}
    local retryFails = (self.iconRetryAccumMs or 0) >= (self.ICON_RETRY_EVERY_MS or 600000)
    if retryFails then
        self.iconRetryAccumMs = 0
        self.failedStoreIcons = {}
    end

    for storeKey, meta in pairs(pending) do
        if self.failedStoreIcons ~= nil and self.failedStoreIcons[storeKey] and not retryFails then
            failedCount = failedCount + 1
        else
            local before = self.copiedStorePaths
                and self.copiedStorePaths[self.baseDir .. string.format("icons/store/%s.dds", storeKey)]
            local ok, rel = self:tryCopyStoreIcon(storeKey, meta.src)
            if ok then
                copiedCount = copiedCount + 1
                if not before then
                    newlyCopied = newlyCopied + 1
                end
                if self.failedStoreIcons ~= nil then
                    self.failedStoreIcons[storeKey] = nil
                end
                table.insert(
                    rows,
                    string.format(
                        '  <store key="%s" filename="%s" iconFile="%s" />\n',
                        self:xmlEscape(storeKey),
                        self:xmlEscape(meta.filename or ""),
                        self:xmlEscape(rel)
                    )
                )
            else
                failedCount = failedCount + 1
                if self.failedStoreIcons == nil then
                    self.failedStoreIcons = {}
                end
                self.failedStoreIcons[storeKey] = true
                if self.loggedStoreIconFails == nil then
                    self.loggedStoreIconFails = {}
                end
                if not self.loggedStoreIconFails[storeKey] then
                    self.loggedStoreIconFails[storeKey] = true
                    if #failSamples < 5 then
                        table.insert(
                            failSamples,
                            string.format("%s src=%s", tostring(storeKey), tostring(meta.src))
                        )
                    end
                end
            end
        end
    end

    -- Keep previously successful rows that were skipped as known fails this pass.
    -- Rows only include successes from this loop; failed keys stay omitted.

    table.sort(rows)
    local fingerprint = table.concat(rows, "")
    local changed = fingerprint ~= self.lastIconsFingerprint
    if not changed and not forceWrite and newlyCopied == 0 then
        return
    end

    local gen = self:nextGeneration()
    local body = string.format(
        [[<?xml version="1.0" encoding="utf-8"?>
<iconsManifest schema="%s" generation="%s" writtenAtUtc="%s" scan="vehicles" kind="store">
%s</iconsManifest>
]],
        self.SCHEMA,
        tostring(gen),
        self:xmlEscape(utcNow()),
        fingerprint
    )
    self:writeTextFile(self.stateDir .. "icons_manifest.xml", body)
    self.lastIconsFingerprint = fingerprint
    if changed or newlyCopied > 0 or #failSamples > 0 then
        log(
            string.format(
                "store icons unique=%s copiedOrPresent=%s new=%s failed=%s",
                tostring(#rows),
                tostring(copiedCount),
                tostring(newlyCopied),
                tostring(failedCount)
            )
        )
    end
    for _, sample in ipairs(failSamples) do
        log("store icon fail (once): " .. sample)
    end
end

function AgriVisionConnector:processCommands()
    local path = self.baseDir .. "command.xml"
    -- Dedicated sandbox: never io.open read. Engine XML API only (Farmhand pattern).
    if XMLFile == nil or XMLFile.loadIfExists == nil then
        return
    end
    if not self:engineFileExists(path) then
        return
    end

    local xmlFile = nil
    local okLoad = pcall(function()
        xmlFile = XMLFile.loadIfExists("agriVisionCmd", path)
    end)
    -- Empty/corrupt command.xml makes the Engine log every tick; remove it.
    if not okLoad or xmlFile == nil then
        self:deletePath(path)
        return
    end

    local id = nil
    local kind = nil
    pcall(function()
        id = xmlFile:getString("command#id") or xmlFile:getString("commands#id")
        kind = xmlFile:getString("command#type")
            or xmlFile:getString("commands#cmd")
            or xmlFile:getString("command#cmd")
    end)
    pcall(function()
        xmlFile:delete()
    end)

    if id == nil or id == "" then
        self:deletePath(path)
        return
    end
    if self.processedCommands[id] then
        self:deletePath(path)
        return
    end

    local status = "unsupported"
    if kind == nil or kind == "" or kind == "ping" or kind == "noop" then
        status = "ok"
    end

    self.processedCommands[id] = true
    local result = string.format(
        [[<?xml version="1.0" encoding="utf-8"?>
<commandResult schema="%s" id="%s" status="%s" writtenAtUtc="%s" connectorVersion="%s" />
]],
        self.SCHEMA,
        self:xmlEscape(id),
        status,
        self:xmlEscape(utcNow()),
        self:xmlEscape(self.VERSION)
    )
    self:writeTextFile(self.baseDir .. "command_result.xml", result)
    self:deletePath(path)
end

function AgriVisionConnector:tick(dt)
    if not self.active then
        return
    end
    -- Prefer frame dt; dedicated g_time can stay 0 and starved the old throttle.
    local step = tonumber(dt) or 0
    if step < 0 then
        step = 0
    end
    -- Engine sometimes reports seconds.
    if step > 0 and step < 1 then
        step = step * 1000
    end
    -- If called with nil/0 dt, still advance so a live hook eventually fires work.
    if step <= 0 then
        step = 16
    end

    self.tickAccumMs = (self.tickAccumMs or 0) + step
    if self.tickAccumMs < self.TICK_MS then
        return
    end
    self.tickAccumMs = 0
    self.fullAccumMs = (self.fullAccumMs or 0) + self.TICK_MS
    self.helloAccumMs = (self.helloAccumMs or 0) + self.TICK_MS
    self.waitLogAccumMs = (self.waitLogAccumMs or 0) + self.TICK_MS
    self.iconRetryAccumMs = (self.iconRetryAccumMs or 0) + self.TICK_MS

    local ok, err = pcall(function()
        if (self.helloAccumMs or 0) >= (self.HELLO_EVERY_MS or 60000) then
            self.helloAccumMs = 0
            self:writeHello()
        end
        self:processCommands()
        if FieldSnapshot ~= nil and FieldSnapshot.writeIfDue ~= nil then
            local okFields, errFields = pcall(FieldSnapshot.writeIfDue, self)
            if not okFields then
                log("fields error: " .. tostring(errFields))
            end
        end
        local hasVehicles = self:missionHasVehicles()
        if not self.vehiclesPrimed and not hasVehicles then
            if self.waitLogAccumMs >= self.WAIT_LOG_EVERY_MS then
                self.waitLogAccumMs = 0
                log("waiting for vehicles (" .. self:missionReadyHint() .. ")")
            end
            return
        end
        local due = (not self.vehiclesPrimed) or (self.fullAccumMs >= self.FULL_VEHICLE_EVERY_MS)
        if due and hasVehicles then
            self.fullAccumMs = 0
            self:writeVehiclesFull()
            self.vehiclesPrimed = true
        end
    end)
    if not ok then
        log("tick error: " .. tostring(err))
    end
end

function AgriVisionConnector:installMissionHook()
    if self.missionHookInstalled then
        return
    end
    if FSBaseMission == nil or Utils == nil or Utils.appendedFunction == nil then
        return
    end
    FSBaseMission.update = Utils.appendedFunction(FSBaseMission.update, function(_, dt)
        AgriVisionConnector:tick(dt)
    end)
    self.missionHookInstalled = true
    log("FSBaseMission.update hook installed")
end

-- addModEventListener calls listener:update(dt). Also keep FSBaseMission hook as backup
-- (dedicated servers have been observed to skip mod listeners after load).
function AgriVisionConnector:update(dt)
    self:installMissionHook()
    self:tick(dt)
end

-- Strong self-reference so the listener table cannot be GC'd.
AgriVisionConnector._listener = AgriVisionConnector
addModEventListener(AgriVisionConnector)
AgriVisionConnector:installMissionHook()
AgriVisionConnector:init()
log("listener registered (missionHook=" .. tostring(AgriVisionConnector.missionHookInstalled == true) .. ")")
