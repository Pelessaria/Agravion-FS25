--[[
  Silo, silo-extension and bale-storage levels for the dashboard.

  The read path follows FS25_LiveDataConnector StorageProvider: placeable
  spec_silo, spec_siloExtension and spec_objectStorage. Nothing is invented
  when the engine does not expose a name, a fill or a capacity.

  Dedicated-server sandbox: no io reads, no os.*, no continue.
]]

StorageSnapshot = {}

StorageSnapshot.EVERY_MS = 60000

local function log(msg)
    print("AgriVisionConnector: " .. tostring(msg))
end

local function safeMethod(object, methodName, ...)
    if object == nil or object[methodName] == nil then
        return nil
    end
    local ok, value = pcall(object[methodName], object, ...)
    if ok then
        return value
    end
    return nil
end

local function num(value)
    local n = tonumber(value)
    if n == nil or n ~= n or n == math.huge or n == -math.huge then
        return nil
    end
    return n
end

local function round(value)
    local n = num(value)
    if n == nil then
        return nil
    end
    return math.floor(n + 0.5)
end

local function xmlEscape(connector, value)
    if connector ~= nil and connector.xmlEscape ~= nil then
        return connector:xmlEscape(value)
    end
    return tostring(value or "")
end

local function attr(connector, name, value)
    if value == nil or value == "" then
        return ""
    end
    return string.format(' %s="%s"', name, xmlEscape(connector, value))
end

local function positiveFarmId(value)
    local farmId = num(value)
    if farmId == nil or farmId <= 0 then
        return nil
    end
    if FarmManager ~= nil and FarmManager.SPECTATOR_FARM_ID ~= nil and farmId == num(FarmManager.SPECTATOR_FARM_ID) then
        return nil
    end
    return farmId
end

local function ownerFarmId(storage, placeable)
    local value = safeMethod(storage, "getOwnerFarmId")
    if value == nil and storage ~= nil then
        value = storage.ownerFarmId
    end
    if value == nil then
        value = safeMethod(placeable, "getOwnerFarmId")
    end
    if value == nil and placeable ~= nil then
        value = placeable.ownerFarmId
    end
    return positiveFarmId(value)
end

local function placeableName(placeable)
    if placeable == nil then
        return nil
    end
    local name = safeMethod(placeable, "getName")
    if name ~= nil and tostring(name) ~= "" then
        return tostring(name)
    end
    if placeable.storeItem ~= nil then
        name = placeable.storeItem.name or placeable.storeItem.title
        if name ~= nil and tostring(name) ~= "" then
            return tostring(name)
        end
    end
    if placeable.name ~= nil and tostring(placeable.name) ~= "" then
        return tostring(placeable.name)
    end
    return nil
end

local function fillInfo(fillTypeId)
    local name = nil
    local title = nil
    local desc = nil
    if g_fillTypeManager ~= nil then
        name = safeMethod(g_fillTypeManager, "getFillTypeNameByIndex", fillTypeId)
        desc = safeMethod(g_fillTypeManager, "getFillTypeByIndex", fillTypeId)
    end
    if type(desc) == "table" then
        if (name == nil or tostring(name) == "") and desc.name ~= nil then
            name = desc.name
        end
        if desc.title ~= nil and tostring(desc.title) ~= "" then
            title = tostring(desc.title)
        end
    end
    if name == nil or tostring(name) == "" then
        return nil, title
    end
    return tostring(name), title
end

local function fillLevels(storage)
    local values = safeMethod(storage, "getFillLevels")
    if type(values) == "table" then
        return values
    end
    if storage ~= nil and type(storage.fillLevels) == "table" then
        return storage.fillLevels
    end
    return {}
end

local function capacityFor(storage, fillTypeId)
    local capacity = safeMethod(storage, "getCapacity", fillTypeId)
    if type(capacity) == "number" and capacity >= 0 and capacity < math.huge then
        return capacity
    end
    if storage ~= nil and type(storage.capacities) == "table" then
        capacity = num(storage.capacities[fillTypeId])
        if capacity ~= nil and capacity >= 0 then
            return capacity
        end
    end
    capacity = storage ~= nil and num(storage.capacity) or nil
    if capacity ~= nil and capacity >= 0 and capacity < math.huge then
        return capacity
    end
    return nil
end

local function totalCapacity(storage)
    if storage == nil then
        return nil
    end
    local capacity = num(storage.capacity)
    if capacity ~= nil and capacity > 0 and capacity < math.huge then
        return capacity
    end
    local capacities = storage.capacities
    if type(capacities) ~= "table" then
        return nil
    end
    local total = 0
    local found = false
    for _, value in pairs(capacities) do
        local amount = num(value)
        if amount ~= nil and amount > 0 and amount < math.huge then
            total = total + amount
            found = true
        end
    end
    if found then
        return total
    end
    return nil
end

local function className(object)
    if object == nil then
        return nil
    end
    local name = object.REFERENCE_CLASS_NAME or object.className
    if name ~= nil and tostring(name) ~= "" then
        return tostring(name)
    end
    return nil
end

local function isBale(object, spec)
    local name = className(object)
    if name ~= nil and string.find(string.lower(name), "bale", 1, true) ~= nil then
        return true
    end
    if spec ~= nil and spec.supportsBales == true and spec.supportsPallets ~= true then
        return true
    end
    return false
end

local function objectFillType(object)
    if object == nil then
        return nil
    end
    local value = safeMethod(object, "getFillType")
    if value == nil then
        value = safeMethod(object, "getFillTypeIndex")
    end
    if value == nil then
        value = object.fillTypeId or object.fillTypeIndex or object.fillType
    end
    local id = num(value)
    if id ~= nil then
        return id
    end
    if value ~= nil and g_fillTypeManager ~= nil and g_fillTypeManager.getFillTypeIndexByName ~= nil then
        id = num(safeMethod(g_fillTypeManager, "getFillTypeIndexByName", string.upper(tostring(value))))
    end
    return id
end

local function objectFillLevel(object)
    if object == nil then
        return nil
    end
    local value = safeMethod(object, "getFillLevel")
    if value == nil then
        value = object.fillLevel
    end
    local amount = num(value)
    if amount == nil or amount < 0 then
        return nil
    end
    return amount
end

local function placeableXZ(placeable)
    if placeable == nil or getWorldTranslation == nil then
        return nil, nil
    end
    local node = placeable.rootNode
    if node == nil and placeable.components ~= nil and placeable.components[1] ~= nil then
        node = placeable.components[1].node
    end
    if node == nil then
        return nil, nil
    end
    local ok, x, _, z = pcall(getWorldTranslation, node)
    if not ok then
        return nil, nil
    end
    x = num(x)
    z = num(z)
    if x == nil or z == nil then
        return nil, nil
    end
    return math.floor(x * 10 + 0.5) / 10, math.floor(z * 10 + 0.5) / 10
end

local function addSilo(bins, storage, placeable, kind, sourceIndex)
    if storage == nil then
        return
    end
    local farmId = ownerFarmId(storage, placeable)
    if farmId == nil then
        return
    end
    local fills = {}
    local total = 0
    for fillTypeId, level in pairs(fillLevels(storage)) do
        local id = num(fillTypeId)
        local amount = num(level) or 0
        if id ~= nil and amount > 0.5 then
            local fillType, title = fillInfo(id)
            if fillType ~= nil then
                fills[#fills + 1] = {
                    fillType = fillType,
                    title = title,
                    level = round(amount),
                    capacity = round(capacityFor(storage, id)),
                }
                total = total + amount
            end
        end
    end
    table.sort(fills, function(a, b)
        return tostring(a.title or a.fillType) < tostring(b.title or b.fillType)
    end)
    local x, z = placeableXZ(placeable)
    bins[#bins + 1] = {
        id = kind .. ":" .. tostring(sourceIndex),
        kind = kind,
        farmId = farmId,
        name = placeableName(placeable),
        foreign = storage.foreignSilo == true,
        level = round(total),
        capacity = round(totalCapacity(storage)),
        x = x,
        z = z,
        fills = fills,
    }
end

local function addBales(bins, placeable, sourceIndex)
    local spec = placeable ~= nil and placeable.spec_objectStorage or nil
    if spec == nil or spec.supportsBales ~= true then
        return
    end
    local farmId = ownerFarmId(nil, placeable)
    if farmId == nil then
        return
    end
    local infos = safeMethod(placeable, "getObjectStorageObjectInfos")
    if type(infos) ~= "table" then
        infos = spec.objectInfos
    end
    if type(infos) ~= "table" then
        infos = {}
    end
    local fills = {}
    local total = 0
    local bales = 0
    for _, info in pairs(infos) do
        if type(info) == "table" then
            local representative = nil
            if type(info.objects) == "table" then
                representative = info.objects[1]
            end
            if representative ~= nil and isBale(representative, spec) then
                local count = num(info.numObjects)
                if count == nil and type(info.objects) == "table" then
                    count = #info.objects
                end
                count = math.floor(count or 0)
                if count > 0 then
                    local fillType, title = nil, nil
                    local fillTypeId = objectFillType(representative)
                    if fillTypeId ~= nil then
                        fillType, title = fillInfo(fillTypeId)
                    end
                    local each = objectFillLevel(representative)
                    local volume = nil
                    if each ~= nil then
                        volume = round(each * count)
                        total = total + each * count
                    end
                    bales = bales + count
                    fills[#fills + 1] = {
                        fillType = fillType,
                        title = title,
                        level = volume,
                        count = count,
                    }
                end
            end
        end
    end
    table.sort(fills, function(a, b)
        return tostring(a.title or a.fillType or "") < tostring(b.title or b.fillType or "")
    end)
    local slots = num(spec.capacity)
    if slots ~= nil and slots < 0 then
        slots = nil
    end
    local used = num(spec.numStoredObjects)
    if used == nil and type(spec.storedObjects) == "table" then
        used = #spec.storedObjects
    end
    if used == nil then
        used = bales
    end
    local x, z = placeableXZ(placeable)
    bins[#bins + 1] = {
        id = "bale:" .. tostring(sourceIndex),
        kind = "baleStorage",
        farmId = farmId,
        name = placeableName(placeable),
        foreign = false,
        level = round(total),
        used = math.max(0, math.floor(used)),
        slots = slots ~= nil and math.floor(slots) or nil,
        x = x,
        z = z,
        fills = fills,
    }
end

local function collect()
    local mission = g_currentMission
    if mission == nil or mission.placeableSystem == nil or type(mission.placeableSystem.placeables) ~= "table" then
        return nil
    end
    local bins = {}
    local siloIndex = 0
    local baleIndex = 0
    local failed = 0
    local function visit(placeable)
        if placeable == nil then
            return
        end
        local ok = pcall(function()
            local silo = placeable.spec_silo
            if silo ~= nil and type(silo.storages) == "table" then
                for _, storage in ipairs(silo.storages) do
                    siloIndex = siloIndex + 1
                    addSilo(bins, storage, placeable, "silo", siloIndex)
                end
            end
            local extension = placeable.spec_siloExtension
            if extension ~= nil and extension.storage ~= nil then
                siloIndex = siloIndex + 1
                addSilo(bins, extension.storage, placeable, "siloExtension", siloIndex)
            end
            if placeable.spec_objectStorage ~= nil then
                baleIndex = baleIndex + 1
                addBales(bins, placeable, baleIndex)
            end
        end)
        if not ok then
            failed = failed + 1
        end
    end
    local listed = 0
    for _, placeable in ipairs(mission.placeableSystem.placeables) do
        listed = listed + 1
        visit(placeable)
    end
    if listed == 0 then
        for _, placeable in pairs(mission.placeableSystem.placeables) do
            visit(placeable)
        end
    end
    table.sort(bins, function(a, b)
        if a.farmId ~= b.farmId then
            return a.farmId < b.farmId
        end
        return tostring(a.name or a.id) < tostring(b.name or b.id)
    end)
    return bins, failed
end

local function binXml(connector, row)
    local lines = {}
    lines[#lines + 1] = string.format(
        "<bin%s%s%s%s%s%s%s%s%s%s%s />",
        attr(connector, "id", row.id),
        attr(connector, "kind", row.kind),
        attr(connector, "farmId", row.farmId),
        attr(connector, "name", row.name),
        attr(connector, "foreign", row.foreign and "1" or nil),
        attr(connector, "level", row.level),
        attr(connector, "capacity", row.capacity),
        attr(connector, "used", row.used),
        attr(connector, "slots", row.slots),
        attr(connector, "x", row.x),
        attr(connector, "z", row.z)
    )
    for _, fill in ipairs(row.fills or {}) do
        lines[#lines + 1] = string.format(
            "<fill%s%s%s%s%s%s />",
            attr(connector, "bin", row.id),
            attr(connector, "fillType", fill.fillType),
            attr(connector, "title", fill.title),
            attr(connector, "level", fill.level),
            attr(connector, "capacity", fill.capacity),
            attr(connector, "count", fill.count)
        )
    end
    return table.concat(lines, "\n")
end

function StorageSnapshot.writeIfDue(connector)
    if connector == nil or connector.stateDir == nil or connector.writeTextFile == nil then
        return
    end
    connector.storageAccumMs = (connector.storageAccumMs or 0) + (connector.TICK_MS or 5000)
    if connector.storageWritten and connector.storageAccumMs < StorageSnapshot.EVERY_MS then
        return
    end
    connector.storageAccumMs = 0

    local bins, failed = collect()
    if bins == nil then
        return
    end
    if failed > 0 and not connector.storageFailLogged then
        connector.storageFailLogged = true
        log("storage placeables skipped=" .. tostring(failed))
    end

    local parts = {}
    local fillCount = 0
    for _, row in ipairs(bins) do
        parts[#parts + 1] = binXml(connector, row)
        fillCount = fillCount + #(row.fills or {})
    end
    local bodyLines = table.concat(parts, "\n")
    if bodyLines == connector.storageFingerprint then
        connector.storageWritten = true
        return
    end
    local writtenAt = "unknown"
    if getDate ~= nil then
        writtenAt = getDate("%Y-%m-%dT%H:%M:%SZ")
    end
    local body = string.format(
        '<?xml version="1.0" encoding="utf-8"?>\n<storageState schema="1" generation="%s" writtenAtUtc="%s">\n%s\n</storageState>\n',
        tostring(connector:nextGeneration()),
        xmlEscape(connector, writtenAt),
        bodyLines
    )
    connector:writeTextFile(connector.stateDir .. "storage_state.xml", body)
    connector.storageFingerprint = bodyLines
    connector.storageWritten = true
    if not connector.storageLogged then
        connector.storageLogged = true
        log(string.format("storage written bins=%s fills=%s", tostring(#bins), tostring(fillCount)))
    end
end
