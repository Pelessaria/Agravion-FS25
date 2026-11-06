--[[
  Positions for the dashboard live map.

  Vehicles that have a map marker, players who are on foot, and placeable
  hotspots. Clock and the current weather come from the running mission.
  Sampling mirrors FS25_FNT_Livemap: ~2 s while the farm is busy (players
  online or unpaused), ~30 s while idle. The dashboard pulls live_map.xml
  on the live-map page; other state stays on the slower cron.

  Dedicated-server sandbox: no io reads, no os.*, no continue.
]]

LiveSnapshot = {}

LiveSnapshot.EVERY_MS = 2000
LiveSnapshot.EVERY_IDLE_MS = 30000

local function log(msg)
    print("AgravionConnector: " .. tostring(msg))
end

-- Giants: avoid pcall on the hot path. Nil-check, then call directly.
local function safeMethod(object, methodName, ...)
    if object == nil then
        return nil
    end
    local method = object[methodName]
    if method == nil then
        return nil
    end
    return method(object, ...)
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

-- Same convention as FNT Livemap: yaw of the node forward axis (0,0,1).
local function headingOf(node)
    if node == nil or localDirectionToWorld == nil then
        return nil
    end
    local dx, _, dz = localDirectionToWorld(node, 0, 0, 1)
    if dx == nil or dz == nil then
        return nil
    end
    if MathUtil ~= nil and MathUtil.getYRotationFromDirection ~= nil then
        return MathUtil.getYRotationFromDirection(dx, dz)
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
                "<vehicle%s%s%s%s%s%s%s%s%s />",
                attr(connector, "id", id),
                attr(connector, "name", name),
                attr(connector, "farmId", farmIdOf(vehicle)),
                attr(connector, "x", round(x, 1)),
                attr(connector, "z", round(z, 1)),
                attr(connector, "heading", heading ~= nil and round(heading, 3) or nil),
                attr(connector, "ai", ai and "1" or nil),
                attr(connector, "driver", driver),
                attr(connector, "controlled", controlled and "1" or nil)
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

local function worldXZ(placeable)
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
    local x, _, z = getWorldTranslation(node)
    return num(x), num(z)
end

local function usedBuilding(kind)
    if type(kind) ~= "string" or kind == "" then
        return false
    end
    local upper = string.upper(kind)
    if string.find(upper, "SILO", 1, true)
        or string.find(upper, "HUSBAND", 1, true)
        or string.find(upper, "ANIMAL", 1, true)
        or string.find(upper, "PRODUCTION", 1, true)
        or string.find(upper, "SELL", 1, true)
        or string.find(upper, "UNLOAD", 1, true)
        or string.find(upper, "LOAD", 1, true)
        or string.find(upper, "BUNKER", 1, true)
        or string.find(upper, "BARN", 1, true)
        or string.find(upper, "STABLE", 1, true)
        or string.find(upper, "WORKSHOP", 1, true)
        or string.find(upper, "GARAGE", 1, true) then
        return true
    end
    return false
end

local function buildingKind(placeable)
    if placeable == nil then
        return nil
    end
    if placeable.spec_silo ~= nil then
        return "silo"
    end
    if placeable.spec_husbandry ~= nil or placeable.spec_animals ~= nil or placeable.spec_animal ~= nil then
        return "husbandry"
    end
    if placeable.spec_productionPoint ~= nil or placeable.spec_production ~= nil then
        return "production"
    end
    return nil
end

local function appendPlace(connector, parts, fingerprint, count, id, name, kind, farmId, x, z)
    parts[#parts + 1] = string.format(
        "<place%s%s%s%s%s%s />",
        attr(connector, "id", id),
        attr(connector, "name", name),
        attr(connector, "type", kind),
        attr(connector, "farmId", farmId),
        attr(connector, "x", round(x, 1)),
        attr(connector, "z", round(z, 1))
    )
    fingerprint[#fingerprint + 1] = string.format("o:%s:%s:%s", tostring(id), tostring(round(x, 0)), tostring(round(z, 0)))
    return count + 1
end

local function appendPlaces(connector, parts, fingerprint)
    local mission = g_currentMission
    local placeables = mission ~= nil and mission.placeableSystem ~= nil and mission.placeableSystem.placeables or nil
    local count = 0
    local seen = {}
    each(placeables, function(placeable)
        if count >= 160 or placeable == nil then
            return
        end
        pcall(function()
            local spec = placeable.spec_hotspots
            local lists = {}
            if spec ~= nil then
                lists[1] = spec.mapHotspots
                lists[2] = spec.hotspots
            end
            local wrote = false
            for _, hotspots in ipairs(lists) do
                each(hotspots, function(hotspot)
                    if count >= 160 or hotspot == nil or wrote then
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
                    local kind = placeTypeName(hotspot) or buildingKind(placeable)
                    if not usedBuilding(kind) then
                        return
                    end
                    local id = placeable.uniqueId or safeMethod(placeable, "getUniqueId") or count
                    local key = tostring(id)
                    if seen[key] then
                        return
                    end
                    seen[key] = true
                    count = appendPlace(connector, parts, fingerprint, count, id, name, kind, farmIdOf(placeable), x, z)
                    wrote = true
                end)
            end
            if wrote then
                return
            end
            local kind = buildingKind(placeable)
            if kind == nil then
                return
            end
            local x, z = worldXZ(placeable)
            if x == nil or z == nil then
                return
            end
            local id = placeable.uniqueId or safeMethod(placeable, "getUniqueId") or count
            local key = tostring(id)
            if seen[key] then
                return
            end
            seen[key] = true
            local name = safeMethod(placeable, "getName")
            count = appendPlace(connector, parts, fingerprint, count, id, name, kind, farmIdOf(placeable), x, z)
        end)
    end)
end

local function hexColor(color)
    if type(color) ~= "table" then
        return nil
    end
    local r = num(color.r or color[1])
    local g = num(color.g or color[2])
    local b = num(color.b or color[3])
    if r == nil or g == nil or b == nil then
        return nil
    end
    if r > 1 or g > 1 or b > 1 then
        r = r / 255
        g = g / 255
        b = b / 255
    end
    local function channel(value)
        local byte = math.floor(math.max(0, math.min(1, value)) * 255 + 0.5)
        return string.format("%02X", byte)
    end
    return "#" .. channel(r) .. channel(g) .. channel(b)
end

local function appendFarms(connector, parts)
    local manager = g_farmManager
    if manager == nil or manager.getFarms == nil then
        return
    end
    local ok, farms = pcall(manager.getFarms, manager)
    if not ok or type(farms) ~= "table" then
        return
    end
    each(farms, function(farm)
        if farm == nil then
            return
        end
        local id = num(farm.farmId)
        if id == nil or id <= 0 then
            return
        end
        local color = nil
        if farm.getColor ~= nil then
            local cok, value = pcall(farm.getColor, farm)
            if cok then
                color = hexColor(value)
            end
        end
        local name = farm.name
        if type(name) ~= "string" or name == "" then
            name = nil
        end
        parts[#parts + 1] = string.format(
            "<farm%s%s%s />",
            attr(connector, "id", id),
            attr(connector, "name", name),
            attr(connector, "color", color)
        )
    end)
end

local function firstNumber(objects, key, places)
    for _, object in ipairs(objects) do
        if type(object) == "table" then
            local value = round(object[key], places)
            if value ~= nil then
                return value
            end
        end
    end
    return nil
end

local function forecastRow(forecast, method, index)
    if forecast == nil or forecast[method] == nil then
        return nil
    end
    local ok, value = pcall(forecast[method], forecast, index)
    if ok and type(value) == "table" then
        return value
    end
    return nil
end

local function clockAndWeather()
    local mission = g_currentMission
    local environment = mission ~= nil and mission.environment or nil
    local clock = {}
    local weather = environment ~= nil and environment.weather or nil
    if environment ~= nil then
        clock.day = num(environment.day) or num(environment.currentDay)
        clock.period = num(environment.period) or num(environment.currentPeriod)
        clock.dayTime = num(environment.dayTime)
        clock.timeScale = num(environment.timeScale)
        clock.year = num(environment.currentYear)
        clock.dayInPeriod = num(environment.currentDayInPeriod)
        clock.daysPerPeriod = num(environment.daysPerPeriod)
    end
    if mission ~= nil and mission.paused == true then
        clock.paused = "1"
    end
    local forecastObject = weather ~= nil and weather.forecast or nil
    local forecast = forecastObject ~= nil and safeMethod(forecastObject, "getCurrentWeather") or nil
    local sources = { forecast, weather }
    if type(forecast) == "table" then
        clock.weather = weatherName(forecast.forecastType)
        clock.temperature = round(forecast.temperature, 1)
        clock.windSpeed = round(forecast.windSpeed, 1)
        clock.windDirection = round(forecast.windDirection, 3)
    end
    clock.rain = firstNumber(sources, "rainScale", 3)
    clock.clouds = firstNumber(sources, "cloudCoverage", 3)
    clock.humidity = firstNumber(sources, "humidity", 3)
    clock.fog = firstNumber(sources, "fogScale", 3)
    clock.snow = firstNumber(sources, "snowHeight", 3)
    clock.hours = {}
    clock.days = {}
    if forecastObject ~= nil then
        for hour = 0, 11 do
            local row = forecastRow(forecastObject, "getHourlyForecast", hour)
            if row ~= nil then
                clock.hours[#clock.hours + 1] = {
                    time = num(row.time),
                    weather = weatherName(row.forecastType),
                    temperature = round(row.temperature, 1),
                    windSpeed = round(row.windSpeed, 1),
                }
            end
        end
        for day = 1, 8 do
            local row = forecastRow(forecastObject, "getDailyForecast", day)
            if row ~= nil then
                clock.days[#clock.days + 1] = {
                    day = num(row.day),
                    weather = weatherName(row.forecastType),
                    high = round(row.highTemperature, 1),
                    low = round(row.lowTemperature, 1),
                    windSpeed = round(row.windSpeed, 1),
                }
            end
        end
    end
    return clock
end

local function farmIsBusy()
    local mission = g_currentMission
    if mission == nil then
        return false
    end
    if mission.paused ~= true then
        return true
    end
    local users = mission.userManager ~= nil and mission.userManager.getUsers ~= nil and mission.userManager:getUsers() or nil
    if type(users) ~= "table" then
        return false
    end
    for _, user in pairs(users) do
        local id = nil
        if user ~= nil and user.getId ~= nil then
            id = user:getId()
        end
        if id ~= nil and id ~= 1 then
            return true
        end
    end
    return false
end

function LiveSnapshot.writeIfDue(connector)
    if connector == nil or connector.stateDir == nil or connector.writeTextFile == nil then
        return
    end
    local interval = farmIsBusy() and LiveSnapshot.EVERY_MS or LiveSnapshot.EVERY_IDLE_MS
    connector.liveAccumMs = (connector.liveAccumMs or interval) + (connector.TICK_MS or 1000)
    if connector.liveAccumMs < interval then
        return
    end
    connector.liveAccumMs = 0

    local parts = {}
    local fingerprint = {}
    appendVehicles(connector, parts, fingerprint)
    appendPlayers(connector, parts, fingerprint)
    appendPlaces(connector, parts, fingerprint)
    appendFarms(connector, parts)
    local clock = clockAndWeather()
    for _, row in ipairs(clock.hours) do
        parts[#parts + 1] = string.format(
            "<hour%s%s%s%s />",
            attr(connector, "time", row.time ~= nil and math.floor(row.time) or nil),
            attr(connector, "type", row.weather),
            attr(connector, "temperature", row.temperature),
            attr(connector, "windSpeed", row.windSpeed)
        )
    end
    for _, row in ipairs(clock.days) do
        parts[#parts + 1] = string.format(
            "<day%s%s%s%s%s />",
            attr(connector, "day", row.day),
            attr(connector, "type", row.weather),
            attr(connector, "high", row.high),
            attr(connector, "low", row.low),
            attr(connector, "windSpeed", row.windSpeed)
        )
    end
    local body = table.concat(parts, "")
    local stamp = string.format(
        "%s|%s|%s|%s|%s|%s|%s",
        tostring(clock.day),
        tostring(clock.dayTime ~= nil and round(clock.dayTime, -4) or ""),
        tostring(clock.weather),
        tostring(clock.temperature),
        tostring(clock.rain),
        tostring(#clock.hours),
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
    local xml = table.concat({
        '<?xml version="1.0" encoding="utf-8"?><live',
        attr(connector, "generation", generation),
        attr(connector, "timestamp", writtenAt),
        attr(connector, "day", clock.day),
        attr(connector, "period", clock.period),
        attr(connector, "year", clock.year),
        attr(connector, "dayInPeriod", clock.dayInPeriod),
        attr(connector, "daysPerPeriod", clock.daysPerPeriod),
        attr(connector, "dayTime", clock.dayTime ~= nil and math.floor(clock.dayTime) or nil),
        attr(connector, "timeScale", clock.timeScale),
        attr(connector, "paused", clock.paused),
        attr(connector, "weather", clock.weather),
        attr(connector, "temperature", clock.temperature),
        attr(connector, "windSpeed", clock.windSpeed),
        attr(connector, "windDirection", clock.windDirection),
        attr(connector, "rain", clock.rain),
        attr(connector, "clouds", clock.clouds),
        attr(connector, "humidity", clock.humidity),
        attr(connector, "fog", clock.fog),
        attr(connector, "snow", clock.snow),
        ">",
        body,
        "</live>",
    })
    connector:writeTextFile(connector.stateDir .. "live_map.xml", xml)
    connector.liveFingerprint = stamp
    if not connector.liveLogged then
        connector.liveLogged = true
        log("live map written")
    end
end
