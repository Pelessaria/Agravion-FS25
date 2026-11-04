--[[
  Positions for the dashboard live map.

  Vehicles that have a map marker, players who are on foot, and placeable
  hotspots. Clock and the current weather come from the running mission.
  The file is a snapshot, not a stream: the dashboard pulls it on its
  existing minute cycle.

  Dedicated-server sandbox: no io reads, no os.*, no continue.
]]

LiveSnapshot = {}

LiveSnapshot.EVERY_MS = 15000

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

local function round(value, places)
    local n = num(value)
    if n == nil then
        return nil
    end
    local scale = 10 ^ (places or 0)
    return math.floor(n * scale + 0.5) / scale
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

local function each(list, visit)
    if type(list) ~= "table" then
        return
    end
    local saw = false
    for _, item in ipairs(list) do
        saw = true
        visit(item)
    end
    if saw then
        return
    end
    for _, item in pairs(list) do
        visit(item)
    end
end

local function headingOf(node)
    if node == nil or localDirectionToWorld == nil then
        return nil
    end
    local ok, dx, _, dz = pcall(localDirectionToWorld, node, 0, 0, 1)
    if not ok or dx == nil or dz == nil then
        return nil
    end
    return math.atan2(dx, dz)
end

local function vehicleNode(vehicle)
    if vehicle == nil then
        return nil
    end
    if vehicle.rootNode ~= nil then
        return vehicle.rootNode
    end
    if vehicle.components ~= nil and vehicle.components[1] ~= nil then
        return vehicle.components[1].node
    end
    return nil
end

local function isPallet(vehicle)
    if vehicle.spec_pallet ~= nil then
        return true
    end
    local typeName = vehicle.typeName
    if type(typeName) == "string" and string.find(string.lower(typeName), "pallet", 1, true) ~= nil then
        return true
    end
    return false
end

local function farmIdOf(object)
    local value = safeMethod(object, "getOwnerFarmId")
    if value == nil and object ~= nil then
        value = object.ownerFarmId
    end
    local farmId = num(value)
    if farmId == nil or farmId <= 0 then
        return nil
    end
    if FarmManager ~= nil and FarmManager.SPECTATOR_FARM_ID ~= nil and farmId == num(FarmManager.SPECTATOR_FARM_ID) then
        return nil
    end
    return farmId
end

local function weatherName(forecastType)
    if forecastType == nil or type(WeatherType) ~= "table" then
        return nil
    end
    for name, value in pairs(WeatherType) do
        if value == forecastType and type(name) == "string" then
            return name
        end
    end
    return nil
end

local function appendVehicles(connector, parts, fingerprint)
    local mission = g_currentMission
    local vehicles = mission ~= nil and mission.vehicleSystem ~= nil and mission.vehicleSystem.vehicles or nil
    each(vehicles, function(vehicle)
        local included = false
        local ok = pcall(function()
            if vehicle == nil or isPallet(vehicle) then
                return
            end
            local controlled = safeMethod(vehicle, "getIsControlled") == true
            if vehicle.mapHotspot == nil and not controlled then
                return
            end
            local node = vehicleNode(vehicle)
            local x, _, z = nil, nil, nil
            if connector.vehicleWorldPos ~= nil then
                x, _, z = connector:vehicleWorldPos(vehicle)
            end
            x = num(x)
            z = num(z)
            if x == nil or z == nil then
                return
            end
            local heading = headingOf(node)
            local name = safeMethod(vehicle, "getName")
            if type(name) ~= "string" or name == "" then
                name = nil
            end
            local id = vehicle.uniqueId or safeMethod(vehicle, "getUniqueId")
            local driver = nil
            local connection = safeMethod(vehicle, "getOwnerConnection")
            if connection ~= nil then
                driver = connection.nickname or connection.userName
            end
            local ai = safeMethod(vehicle, "getIsAIActive") == true
            parts[#parts + 1] = string.format(
                "<vehicle%s%s%s%s%s%s%s%s />",
                attr(connector, "id", id),
                attr(connector, "name", name),
                attr(connector, "farmId", farmIdOf(vehicle)),
                attr(connector, "x", round(x, 1)),
                attr(connector, "z", round(z, 1)),
                attr(connector, "heading", heading ~= nil and round(heading, 3) or nil),
                attr(connector, "ai", ai and "1" or nil),
                attr(connector, "driver", driver)
            )
            fingerprint[#fingerprint + 1] = string.format(
                "v:%s:%s:%s:%s",
                tostring(id),
                tostring(round(x, 0)),
                tostring(round(z, 0)),
                tostring(heading ~= nil and round(heading, 1) or "")
            )
            included = true
        end)
        if not ok and not included and not connector.liveVehicleLogged then
            connector.liveVehicleLogged = true
            log("live vehicle skipped")
        end
    end)
end

local function appendPlayers(connector, parts, fingerprint)
    local mission = g_currentMission
    local users = mission ~= nil and mission.userManager ~= nil and safeMethod(mission.userManager, "getUsers") or nil
    each(users, function(user)
        pcall(function()
            if user == nil then
                return
            end
            local userId = num(user.id) or num(safeMethod(user, "getId"))
            if userId == nil or userId <= 1 then
                return
            end
            local connection = safeMethod(user, "getConnection")
            local player = nil
            if connection ~= nil and mission.connectionsToPlayer ~= nil then
                player = mission.connectionsToPlayer[connection]
            end
            if player == nil then
                return
            end
            if safeMethod(player, "getCurrentVehicle") ~= nil then
                return
            end
            local motion = player.positionalInterpolator
            local x = motion ~= nil and num(motion.positionX) or nil
            local z = motion ~= nil and num(motion.positionZ) or nil
            if x == nil or z == nil then
                return
            end
            local heading = motion ~= nil and num(motion.yaw) or nil
            local name = user.nickname or connection.nickname
            parts[#parts + 1] = string.format(
                "<player%s%s%s%s%s />",
                attr(connector, "id", userId),
                attr(connector, "name", name),
                attr(connector, "x", round(x, 1)),
                attr(connector, "z", round(z, 1)),
                attr(connector, "heading", heading ~= nil and round(heading, 3) or nil)
            )
            fingerprint[#fingerprint + 1] = string.format("p:%s:%s:%s", tostring(userId), tostring(round(x, 0)), tostring(round(z, 0)))
        end)
    end)
end

local function placeTypeName(hotspot)
    local kind = hotspot.placeableType or hotspot.hotspotType or hotspot.type
    if type(kind) == "string" then
        return kind
    end
    if type(PlaceableHotspot) == "table" and type(PlaceableHotspot.TYPE) == "table" then
        for name, value in pairs(PlaceableHotspot.TYPE) do
            if value == kind and type(name) == "string" then
                return name
            end
        end
    end
    return nil
end

local function appendPlaces(connector, parts, fingerprint)
    local mission = g_currentMission
    local placeables = mission ~= nil and mission.placeableSystem ~= nil and mission.placeableSystem.placeables or nil
    local count = 0
    each(placeables, function(placeable)
        if count >= 120 then
            return
        end
        pcall(function()
            local spec = placeable ~= nil and placeable.spec_hotspots or nil
            local hotspots = spec ~= nil and spec.hotspots or nil
            each(hotspots, function(hotspot)
                if count >= 120 or hotspot == nil then
                    return
                end
                local x = num(hotspot.worldX)
                local z = num(hotspot.worldZ)
                if x == nil or z == nil then
                    return
                end
                local name = hotspot.name
                if type(name) ~= "string" or name == "" then
                    name = safeMethod(placeable, "getName")
                end
                local id = placeable.uniqueId or safeMethod(placeable, "getUniqueId") or count
                parts[#parts + 1] = string.format(
                    "<place%s%s%s%s%s%s />",
                    attr(connector, "id", id),
                    attr(connector, "name", name),
                    attr(connector, "type", placeTypeName(hotspot)),
                    attr(connector, "farmId", farmIdOf(placeable)),
                    attr(connector, "x", round(x, 1)),
                    attr(connector, "z", round(z, 1))
                )
                fingerprint[#fingerprint + 1] = string.format("o:%s:%s:%s", tostring(id), tostring(round(x, 0)), tostring(round(z, 0)))
                count = count + 1
            end)
        end)
    end)
end

local function clockAndWeather()
    local mission = g_currentMission
    local environment = mission ~= nil and mission.environment or nil
    local clock = {}
    if environment ~= nil then
        clock.day = num(environment.day)
        clock.period = num(environment.period)
        clock.dayTime = num(environment.dayTime)
        clock.timeScale = num(environment.timeScale)
    end
    if mission ~= nil and mission.paused == true then
        clock.paused = "1"
    end
    local forecast = nil
    if environment ~= nil and environment.weather ~= nil and environment.weather.forecast ~= nil then
        forecast = safeMethod(environment.weather.forecast, "getCurrentWeather")
    end
    if type(forecast) == "table" then
        clock.weather = weatherName(forecast.forecastType)
        clock.temperature = round(forecast.temperature, 1)
        clock.windSpeed = round(forecast.windSpeed, 1)
        clock.windDirection = round(forecast.windDirection, 3)
    end
    return clock
end

function LiveSnapshot.writeIfDue(connector)
    if connector == nil or connector.stateDir == nil or connector.writeTextFile == nil then
        return
    end
    connector.liveAccumMs = (connector.liveAccumMs or LiveSnapshot.EVERY_MS) + (connector.TICK_MS or 5000)
    if connector.liveAccumMs < LiveSnapshot.EVERY_MS then
        return
    end
    connector.liveAccumMs = 0

    local parts = {}
    local fingerprint = {}
    appendVehicles(connector, parts, fingerprint)
    appendPlayers(connector, parts, fingerprint)
    appendPlaces(connector, parts, fingerprint)
    local clock = clockAndWeather()
    local body = table.concat(parts, "")
    local stamp = string.format(
        "%s|%s|%s|%s|%s",
        tostring(clock.day),
        tostring(clock.dayTime ~= nil and round(clock.dayTime, -4) or ""),
        tostring(clock.weather),
        tostring(clock.temperature),
        body
    )
    if stamp == connector.liveFingerprint then
        return
    end

    local generation = 1
    if connector.nextGeneration ~= nil then
        generation = connector:nextGeneration()
    end
    local writtenAt = ""
    if g_currentMission ~= nil and g_currentMission.time ~= nil then
        writtenAt = tostring(math.floor(g_currentMission.time))
    end
    local xml = string.format(
        '<?xml version="1.0" encoding="utf-8"?><live%s%s%s%s%s%s%s%s%s%s%s>%s</live>',
        attr(connector, "generation", generation),
        attr(connector, "timestamp", writtenAt),
        attr(connector, "day", clock.day),
        attr(connector, "period", clock.period),
        attr(connector, "dayTime", clock.dayTime ~= nil and math.floor(clock.dayTime) or nil),
        attr(connector, "timeScale", clock.timeScale),
        attr(connector, "paused", clock.paused),
        attr(connector, "weather", clock.weather),
        attr(connector, "temperature", clock.temperature),
        attr(connector, "windSpeed", clock.windSpeed),
        attr(connector, "windDirection", clock.windDirection),
        body
    )
    connector:writeTextFile(connector.stateDir .. "live_map.xml", xml)
    connector.liveFingerprint = stamp
    if not connector.liveLogged then
        connector.liveLogged = true
        log("live map written")
    end
end
