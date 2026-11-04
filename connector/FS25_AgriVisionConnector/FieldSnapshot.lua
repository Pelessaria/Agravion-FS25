--[[
  Field geometry + state for the dashboard.

  Geometry (polygon outlines) is collected once per field set and written to
  state/fields_geometry.xml. Joined-field groups are measured again whenever
  field state is written, because plowing between parcels changes the join
  without moving the outlines. Farmlands hidden from the buy screen and not
  owned by a player farm are omitted: maps use those for mission and scenery
  ground, and their polygons are not fields the player can buy.
  Crop / ground / Precision Farming state is swept
  in small batches and written about once a minute to state/fields_state.xml.

  Read patterns for field state and Precision Farming samples follow
  FS25_LiveDataConnector FieldProvider. Polygon points are read from the
  field's polygonPoints nodes or a density-map polygon when the engine
  exposes one. Missing values are omitted — the dashboard shows them as
  unavailable.

  Dedicated-server sandbox: no io.open reads, no per-frame scans.
]]

FieldSnapshot = {}

FieldSnapshot.STATE_EVERY_MS = 60000
FieldSnapshot.GEOMETRY_BUDGET = 20
FieldSnapshot.STATE_BUDGET_PF = 12
FieldSnapshot.STATE_BUDGET = 48
FieldSnapshot.MAX_POINTS = 160

local function log(msg)
    print("AgriVisionConnector: " .. tostring(msg))
end

local function safeCall(fn, ...)
    if fn == nil then
        return nil
    end
    local ok, a, b, c = pcall(fn, ...)
    if ok then
        return a, b, c
    end
    return nil
end

local function safeMethod(object, methodName, ...)
    if object == nil or object[methodName] == nil then
        return nil
    end
    return safeCall(object[methodName], object, ...)
end

local function num(value)
    return tonumber(value)
end

local function round(value, places)
    local n = tonumber(value)
    if n == nil then
        return nil
    end
    local scale = 10 ^ (places or 1)
    return math.floor(n * scale + 0.5) / scale
end

local function xmlEscape(connector, value)
    if connector ~= nil and connector.xmlEscape ~= nil then
        return connector:xmlEscape(value)
    end
    return tostring(value or "")
end

local function attr(connector, name, value)
    if value == nil then
        return ""
    end
    return string.format(' %s="%s"', name, xmlEscape(connector, value))
end

local function decodeNitrogen(value)
    value = tonumber(value)
    if value == nil then
        return nil
    end
    -- Precision Farming may expose the density-map index instead of kg/ha.
    if value >= 1 and value <= 45 and value % 1 == 0 then
        return math.max(0, (value - 1) * 5)
    end
    return value
end

local function decodePh(value)
    value = tonumber(value)
    if value == nil then
        return nil
    end
    -- Precision Farming pH density-map index 1..31 -> actual pH.
    if value >= 1 and value <= 31 and value % 1 == 0 then
        return (value * 0.125) + 4.375
    end
    return value
end

local function getPrecisionFarming()
    if type(FS25_precisionFarming) == "table" and FS25_precisionFarming.g_precisionFarming ~= nil then
        return FS25_precisionFarming.g_precisionFarming
    end
    if g_precisionFarming ~= nil then
        return g_precisionFarming
    end
    return nil
end

local function terrainSize()
    if g_currentMission == nil then
        return nil
    end
    local size = num(g_currentMission.terrainSize)
    if size ~= nil and size > 64 then
        return size
    end
    return nil
end

local function pushPoint(points, x, z)
    x = num(x)
    z = num(z)
    if x == nil or z == nil then
        return
    end
    local n = #points
    if n > 0 then
        local last = points[n]
        if math.abs(last.x - x) < 0.05 and math.abs(last.z - z) < 0.05 then
            return
        end
    end
    if n >= 512 then
        return
    end
    points[n + 1] = { x = x, z = z }
end

local function pointsFromNode(node)
    local points = {}
    if node == nil or node == 0 or getNumOfChildren == nil or getChildAt == nil or getWorldTranslation == nil then
        return points
    end
    local count = safeCall(getNumOfChildren, node)
    count = num(count)
    if count == nil or count <= 0 then
        return points
    end
    local limit = math.min(count, 512)
    for i = 0, limit - 1 do
        local child = safeCall(getChildAt, node, i)
        if child ~= nil then
            local x, _, z = safeCall(getWorldTranslation, child)
            pushPoint(points, x, z)
        end
    end
    return points
end

local function findPolygonNode(root)
    if root == nil or root == 0 or getName == nil or getNumOfChildren == nil or getChildAt == nil then
        return nil
    end
    local stack = { root }
    local seen = 0
    while #stack > 0 and seen < 64 do
        local node = table.remove(stack)
        seen = seen + 1
        local name = safeCall(getName, node)
        if name == "polygonPoints" then
            return node
        end
        local count = num(safeCall(getNumOfChildren, node))
        if count ~= nil and count > 0 then
            local limit = math.min(count, 16)
            for i = 0, limit - 1 do
                local child = safeCall(getChildAt, node, i)
                if child ~= nil then
                    stack[#stack + 1] = child
                end
            end
        end
    end
    return nil
end

local function pointsFromVertices(vertices)
    local points = {}
    if type(vertices) ~= "table" then
        return points
    end
    if type(vertices[1]) == "number" and type(vertices[2]) == "number" then
        local i = 1
        while type(vertices[i]) == "number" and type(vertices[i + 1]) == "number" and #points < 512 do
            pushPoint(points, vertices[i], vertices[i + 1])
            i = i + 2
        end
        return points
    end
    local limit = math.min(#vertices, 512)
    for i = 1, limit do
        local v = vertices[i]
        if type(v) == "table" then
            pushPoint(points, v.x or v[1], v.z or v.y or v[2])
        end
    end
    return points
end

local function pointsFromTable(candidate)
    if type(candidate) ~= "table" then
        return {}
    end
    if type(candidate.vertices) == "table" then
        local fromVertices = pointsFromVertices(candidate.vertices)
        if #fromVertices >= 3 then
            return fromVertices
        end
    end
    if type(candidate.points) == "table" then
        local fromPoints = pointsFromTable(candidate.points)
        if #fromPoints >= 3 then
            return fromPoints
        end
    end
    return pointsFromVertices(candidate)
end

local function collectPolygon(field)
    local best = {}
    local function consider(points)
        if type(points) == "table" and #points > #best then
            best = points
        end
    end

    local tables = {
        field.densityMapPolygon,
        field.polygon,
        field.points,
        field.fieldPoints,
        field.polygonPoints,
    }
    for _, candidate in ipairs(tables) do
        consider(pointsFromTable(candidate))
    end

    local roots = {
        field.rootNode,
        field.fieldNode,
        field.node,
        field.i3dNode,
    }
    if field.nameIndicator ~= nil and getParent ~= nil then
        local parent = safeCall(getParent, field.nameIndicator)
        roots[#roots + 1] = parent
    end
    for _, root in ipairs(roots) do
        consider(pointsFromNode(findPolygonNode(root)))
    end
    if type(field.polygonPoints) == "number" then
        consider(pointsFromNode(field.polygonPoints))
    end

    return best
end

local function polygonArea(points)
    if #points < 3 then
        return nil
    end
    local sum = 0
    local count = #points
    for i = 1, count do
        local p1 = points[i]
        local p2 = points[(i % count) + 1]
        sum = sum + (p1.x * p2.z - p2.x * p1.z)
    end
    local area = math.abs(sum) * 0.5
    if area > 0 then
        return area
    end
    return nil
end

local function fieldAreaHa(field, points)
    if field ~= nil then
        local ha = num(field.areaHa) or num(field.fieldAreaHa) or num(field.hectares)
        if ha ~= nil and ha > 0 then
            return ha
        end
        local sqm = num(field.areaSqm) or num(field.fieldAreaSqm) or num(field.fieldArea) or num(field.sizeSqm)
        if sqm ~= nil and sqm > 0 then
            return sqm / 10000
        end
        if field.getArea ~= nil then
            local value = num(safeMethod(field, "getArea"))
            if value ~= nil and value > 0 then
                return value / 10000
            end
        end
    end
    local area = polygonArea(points)
    if area ~= nil then
        return area / 10000
    end
    return nil
end

local function segmentDistance(point, ax, az, bx, bz)
    local dx = bx - ax
    local dz = bz - az
    local len2 = dx * dx + dz * dz
    if len2 < 0.0001 then
        local ex = point.x - ax
        local ez = point.z - az
        return math.sqrt(ex * ex + ez * ez)
    end
    local t = ((point.x - ax) * dx + (point.z - az) * dz) / len2
    if t < 0 then
        t = 0
    elseif t > 1 then
        t = 1
    end
    local px = ax + t * dx
    local pz = az + t * dz
    local ex = point.x - px
    local ez = point.z - pz
    return math.sqrt(ex * ex + ez * ez)
end

-- Keep corners. Dropping every Nth point of a concave outline draws chords
-- across the field, which show up as areas the game does not have.
local function simplifyClosed(points, epsilon)
    local count = #points
    if count < 4 then
        return points
    end
    local far = 2
    local farDist = -1
    local i = 2
    while i <= count do
        local dx = points[i].x - points[1].x
        local dz = points[i].z - points[1].z
        local dist = dx * dx + dz * dz
        if dist > farDist then
            farDist = dist
            far = i
        end
        i = i + 1
    end
    local keep = {}
    local function mark(first, last)
        local maxDist = 0
        local index = first
        local cursor = first + 1
        while cursor < last do
            local dist = segmentDistance(points[cursor], points[first].x, points[first].z, points[last].x, points[last].z)
            if dist > maxDist then
                maxDist = dist
                index = cursor
            end
            cursor = cursor + 1
        end
        if maxDist > epsilon and index ~= first and index ~= last then
            mark(first, index)
            mark(index, last)
        else
            keep[first] = true
            keep[last] = true
        end
    end
    mark(1, far)
    mark(far, count)
    keep[1] = true
    keep[count] = true
    local out = {}
    i = 1
    while i <= count do
        if keep[i] then
            out[#out + 1] = points[i]
        end
        i = i + 1
    end
    return out
end

local function simplify(points)
    local count = #points
    if count <= FieldSnapshot.MAX_POINTS then
        return points
    end
    local epsilon = 1.5
    local out = points
    while epsilon < 80 do
        out = simplifyClosed(points, epsilon)
        if #out <= FieldSnapshot.MAX_POINTS then
            return out
        end
        epsilon = epsilon * 1.6
    end
    return out
end

local function pointString(points)
    local parts = {}
    for _, point in ipairs(points) do
        parts[#parts + 1] = string.format("%.1f,%.1f", point.x, point.z)
    end
    if #parts == 0 then
        return nil
    end
    return table.concat(parts, " ")
end

local function centroid(points)
    if #points == 0 then
        return nil, nil
    end
    local sx, sz = 0, 0
    for _, point in ipairs(points) do
        sx = sx + point.x
        sz = sz + point.z
    end
    return sx / #points, sz / #points
end

-- A farmland with showOnFarmlandsScreen false is not on the buy screen.
-- Owned land stays, so a farm does not lose a field it already holds.
local function shownToPlayer(field)
    local farmland = nil
    if field ~= nil and type(field.farmland) == "table" then
        farmland = field.farmland
    end
    if farmland == nil or farmland.showOnFarmlandsScreen ~= false then
        return true
    end
    local farmId = num(farmland.farmId)
    return farmId ~= nil and farmId > 0
end

local function indexFields()
    local ids = {}
    local byId = {}
    local hidden = 0
    if g_fieldManager == nil or g_fieldManager.fields == nil then
        return ids, byId, hidden
    end
    for _, field in pairs(g_fieldManager.fields) do
        if field ~= nil and field.getId ~= nil then
            local id = num(safeMethod(field, "getId"))
            if id ~= nil then
                if shownToPlayer(field) then
                    ids[#ids + 1] = id
                    byId[id] = field
                else
                    hidden = hidden + 1
                end
            end
        end
    end
    table.sort(ids, function(a, b)
        return a < b
    end)
    return ids, byId, hidden
end

local function collectGeometry(field, id)
    local points = {}
    local cx, cz = nil, nil
    if field ~= nil then
        points = collectPolygon(field)
        if field.getCenterOfFieldWorldPosition ~= nil then
            local a, b = safeMethod(field, "getCenterOfFieldWorldPosition")
            cx = num(a)
            cz = num(b)
        end
    end
    local area = fieldAreaHa(field, points)
    if cx == nil or cz == nil then
        cx, cz = centroid(points)
    end
    -- The PDA draws the field number at the name indicator (field.posX/posZ
    -- after Field:load), which can sit away from the geometric center.
    local lx, lz = cx, cz
    if field ~= nil then
        local okx, px = pcall(function()
            return field.posX
        end)
        local okz, pz = pcall(function()
            return field.posZ
        end)
        px = okx and num(px) or nil
        pz = okz and num(pz) or nil
        if px ~= nil and pz ~= nil then
            lx, lz = px, pz
        end
    end
    local outline = simplify(points)
    return {
        id = id,
        cx = round(cx, 1),
        cz = round(cz, 1),
        lx = round(lx, 1),
        lz = round(lz, 1),
        areaHa = round(area, 2),
        points = pointString(outline),
        raw = outline,
    }
end

local function fruitKey(name)
    if name == nil then
        return nil
    end
    local key = string.lower(tostring(name))
    key = string.gsub(key, "[^a-z0-9]", "")
    if key == "" then
        return nil
    end
    return key
end

local function fruitInfo(fruitTypeIndex)
    if fruitTypeIndex == nil or g_fruitTypeManager == nil or g_fruitTypeManager.getFruitTypeByIndex == nil then
        return nil, nil, nil
    end
    local fruit = safeMethod(g_fruitTypeManager, "getFruitTypeByIndex", fruitTypeIndex)
    if fruit == nil then
        return nil, nil, nil
    end
    local title = nil
    if type(fruit.fillType) == "table" then
        title = fruit.fillType.title or fruit.fillType.name
    end
    return fruit.name, title, fruit
end

local function fruitIconSource(fruit)
    if type(fruit) ~= "table" or type(fruit.fillType) ~= "table" then
        return nil
    end
    local fill = fruit.fillType
    if type(fill.hudOverlay) == "table" then
        local overlayName = fill.hudOverlay.filename or fill.hudOverlay.overlayFilename
        if type(overlayName) == "string" and overlayName ~= "" then
            return overlayName
        end
    end
    return fill.hudOverlayFilename or fill.hudOverlayFilenameSmall or fill.iconFilename
end

local function isGameArchivePath(path)
    if type(path) ~= "string" then
        return true
    end
    local lower = string.lower(path)
    if string.find(lower, "$data", 1, true) ~= nil then
        return true
    end
    if string.find(lower, "datas/", 1, true) ~= nil or string.find(lower, "datas.gar", 1, true) ~= nil then
        return true
    end
    return false
end

local function queueFruitIcon(connector, fruit)
    local key = fruitKey(fruit ~= nil and fruit.name or nil)
    local src = fruitIconSource(fruit)
    if key == nil or src == nil or src == "" or isGameArchivePath(src) or connector.fruitsIconsDir == nil then
        return key
    end
    connector.pendingFruitIcons = connector.pendingFruitIcons or {}
    if connector.copiedFruitIcons ~= nil and connector.copiedFruitIcons[key] then
        return key
    end
    connector.pendingFruitIcons[key] = src
    return key
end

local function classifyCrop(fruit, growthState)
    if fruit == nil then
        return "noCrop"
    end
    growthState = num(growthState) or 0
    if fruit.getIsWithered ~= nil then
        local withered = safeMethod(fruit, "getIsWithered", growthState)
        if withered == true then
            return "withered"
        end
    end
    if fruit.getIsCut ~= nil then
        local cut = safeMethod(fruit, "getIsCut", growthState)
        if cut == true then
            return "cut"
        end
    end
    local minHarvest = num(fruit.minHarvestingGrowthState)
    local maxHarvest = num(fruit.maxHarvestingGrowthState)
    if minHarvest ~= nil and maxHarvest ~= nil and growthState >= minHarvest and growthState <= maxHarvest then
        return "harvestReady"
    end
    if growthState > 0 then
        return "growing"
    end
    return "planted"
end

local function resolveFarmland(x, z)
    if x == nil or z == nil or g_farmlandManager == nil or g_farmlandManager.getFarmlandAtWorldPosition == nil then
        return nil
    end
    return safeMethod(g_farmlandManager, "getFarmlandAtWorldPosition", x, z)
end

local function ownership(field, fieldState, cx, cz)
    local farmlandId, farmId = nil, nil
    if field ~= nil and type(field.farmland) == "table" then
        farmlandId = num(field.farmland.id)
        farmId = num(field.farmland.farmId)
    end
    if fieldState ~= nil then
        if farmlandId == nil then
            farmlandId = num(fieldState.farmlandId)
        end
        if farmId == nil then
            farmId = num(fieldState.ownerFarmId)
        end
    end
    if g_farmlandManager ~= nil and farmlandId ~= nil and g_farmlandManager.getFarmlandById ~= nil then
        local farmland = safeMethod(g_farmlandManager, "getFarmlandById", farmlandId)
        if farmland ~= nil and num(farmland.farmId) ~= nil then
            farmId = num(farmland.farmId)
        end
    end
    if farmId == nil then
        local farmland = resolveFarmland(cx, cz)
        if farmland ~= nil then
            farmlandId = num(farmland.id) or farmlandId
            farmId = num(farmland.farmId)
        end
    end
    if farmId ~= nil and farmId <= 0 then
        farmId = nil
    end
    return farmlandId, farmId
end

local function samplePrecision(precisionFarming, farmlandId, cx, cz, fruitTypeIndex)
    if precisionFarming == nil or cx == nil or cz == nil then
        return { available = precisionFarming ~= nil }
    end
    local soilMap = precisionFarming.soilMap
    local nitrogenMap = precisionFarming.nitrogenMap
    local phMap = precisionFarming.pHMap
    if soilMap == nil or nitrogenMap == nil or phMap == nil then
        return { available = true }
    end

    local function sampleAt(x, z)
        if farmlandId ~= nil then
            local farmland = resolveFarmland(x, z)
            if farmland == nil or num(farmland.id) ~= farmlandId then
                return nil
            end
        end
        local soilType = num(safeMethod(soilMap, "getTypeIndexAtWorldPos", x, z))
        if soilType == nil or soilType <= 0 then
            return nil
        end
        local n = decodeNitrogen(safeMethod(nitrogenMap, "getLevelAtWorldPos", x, z))
        local nTarget = decodeNitrogen(safeMethod(nitrogenMap, "getTargetLevelAtWorldPos", x, z))
        if (nTarget == nil or nTarget <= 0) and fruitTypeIndex ~= nil then
            nTarget = decodeNitrogen(safeMethod(nitrogenMap, "getTargetLevelAtWorldPos", x, z, fruitTypeIndex))
        end
        local ph = decodePh(safeMethod(phMap, "getLevelAtWorldPos", x, z))
        local phTarget = decodePh(safeMethod(phMap, "getOptimalPHValueForSoilTypeIndex", soilType))
        return soilType, n, nTarget, ph, phTarget
    end

    local soil, n, nTarget, ph, phTarget = sampleAt(cx, cz)
    if soil == nil then
        return { available = true, scanned = false }
    end

    local sumN, countN = 0, 0
    local sumNt, countNt = 0, 0
    local sumPh, countPh = 0, 0
    local sumPht, countPht = 0, 0
    local soils = {}

    local function take(soilType, nitrogen, nitrogenTarget, phValue, phTarget)
        if soilType == nil then
            return
        end
        soils[soilType] = (soils[soilType] or 0) + 1
        if nitrogen ~= nil and nitrogen >= 0 then
            sumN = sumN + nitrogen
            countN = countN + 1
        end
        if nitrogenTarget ~= nil and nitrogenTarget > 0 then
            sumNt = sumNt + nitrogenTarget
            countNt = countNt + 1
        end
        if phValue ~= nil and phValue > 0 then
            sumPh = sumPh + phValue
            countPh = countPh + 1
        end
        if phTarget ~= nil and phTarget > 0 then
            sumPht = sumPht + phTarget
            countPht = countPht + 1
        end
    end

    take(soil, n, nTarget, ph, phTarget)
    local offsets = { { 18, 0 }, { -18, 0 }, { 0, 18 }, { 0, -18 } }
    for _, offset in ipairs(offsets) do
        local soilType, nitrogen, nitrogenTarget, phValue, phTargetValue = sampleAt(cx + offset[1], cz + offset[2])
        take(soilType, nitrogen, nitrogenTarget, phValue, phTargetValue)
    end

    local bestSoil, bestCount = soil, 0
    for soilType, count in pairs(soils) do
        if count > bestCount then
            bestSoil = soilType
            bestCount = count
        end
    end

    local soilName = nil
    local types = soilMap.soilTypes or soilMap.types
    if type(types) == "table" then
        local entry = types[bestSoil]
        if type(entry) == "table" then
            local name = entry.name or entry.title
            if type(name) == "string" and name ~= "" then
                soilName = name
            end
        elseif type(entry) == "string" and entry ~= "" then
            soilName = entry
        end
    end

    return {
        available = true,
        scanned = true,
        nitrogen = countN > 0 and (sumN / countN) or nil,
        nitrogenTarget = countNt > 0 and (sumNt / countNt) or nil,
        ph = countPh > 0 and (sumPh / countPh) or nil,
        phTarget = countPht > 0 and (sumPht / countPht) or nil,
        soil = bestSoil,
        soilName = soilName,
    }
end

local FORAGE_FRUIT = {
    GRASS = true,
    MEADOW = true,
    FIELDGRASS = true,
}

local function pointInside(points, x, z)
    local inside = false
    local count = #points
    local j = count
    local i = 1
    while i <= count do
        local pi = points[i]
        local pj = points[j]
        if (pi.z > z) ~= (pj.z > z) then
            local denom = pj.z - pi.z
            if denom ~= 0 and x < (pj.x - pi.x) * (z - pi.z) / denom + pi.x then
                inside = not inside
            end
        end
        j = i
        i = i + 1
    end
    return inside
end

local function precisionGrid(precisionFarming, farmlandId, points)
    if precisionFarming == nil or type(points) ~= "table" or #points < 3 then
        return nil
    end
    local soilMap = precisionFarming.soilMap
    local nitrogenMap = precisionFarming.nitrogenMap
    local phMap = precisionFarming.pHMap
    if soilMap == nil or nitrogenMap == nil or phMap == nil then
        return nil
    end
    local minX, maxX, minZ, maxZ = 1e12, -1e12, 1e12, -1e12
    local index = 1
    while index <= #points do
        local point = points[index]
        if point.x < minX then minX = point.x end
        if point.x > maxX then maxX = point.x end
        if point.z < minZ then minZ = point.z end
        if point.z > maxZ then maxZ = point.z end
        index = index + 1
    end
    local span = math.max(maxX - minX, maxZ - minZ)
    if span < 1 then
        return nil
    end
    local step = math.max(12, span / 7)
    local parts = {}
    local count = 0
    local z = minZ + step * 0.5
    while z < maxZ and count < 64 do
        local x = minX + step * 0.5
        while x < maxX and count < 64 do
            if pointInside(points, x, z) then
                local onField = true
                if farmlandId ~= nil then
                    local farmland = resolveFarmland(x, z)
                    if farmland == nil or num(farmland.id) ~= farmlandId then
                        onField = false
                    end
                end
                if onField then
                    local soilType = num(safeMethod(soilMap, "getTypeIndexAtWorldPos", x, z))
                    if soilType ~= nil and soilType > 0 then
                        local nitrogen = decodeNitrogen(safeMethod(nitrogenMap, "getLevelAtWorldPos", x, z))
                        local phValue = decodePh(safeMethod(phMap, "getLevelAtWorldPos", x, z))
                        local phText = ""
                        if phValue ~= nil and phValue > 0 then
                            phText = string.format("%.2f", phValue)
                        end
                        local nitrogenText = ""
                        if nitrogen ~= nil and nitrogen >= 0 then
                            nitrogenText = string.format("%.0f", nitrogen)
                        end
                        count = count + 1
                        parts[count] = string.format("%.0f,%.0f,%s,%s", x, z, phText, nitrogenText)
                    end
                end
            end
            x = x + step
        end
        z = z + step
    end
    if count == 0 then
        return nil
    end
    return string.format("%.0f|%s", step, table.concat(parts, ";"))
end

local function tallyValue(bag, key, value)
    if value == nil then
        return
    end
    local slot = bag[key]
    if slot == nil then
        slot = {}
        bag[key] = slot
    end
    local text = tostring(value)
    slot[text] = (slot[text] or 0) + 1
end

local function modeNumber(slot)
    if slot == nil then
        return nil
    end
    local best, bestCount = nil, 0
    for text, count in pairs(slot) do
        if count > bestCount then
            best = text
            bestCount = count
        end
    end
    return num(best)
end

local function packExtra(bag)
    if bag == nil then
        return nil
    end
    return {
        weed = modeNumber(bag.weed),
        weedFactor = modeNumber(bag.weedFactor),
        stones = modeNumber(bag.stones),
        ground = modeNumber(bag.ground),
        spray = modeNumber(bag.spray),
        sprayType = modeNumber(bag.sprayType),
        lime = modeNumber(bag.lime),
        roller = modeNumber(bag.roller),
        plow = modeNumber(bag.plow),
        stubble = modeNumber(bag.stubble),
        water = modeNumber(bag.water),
    }
end

local function monthsFromPeriodRow(row, minH, maxH)
    if type(row) ~= "table" or minH == nil or maxH == nil then
        return nil
    end
    local months = {}
    local month = 1
    while month <= 12 do
        local cell = row[month]
        local state = nil
        if type(cell) == "number" then
            state = cell
        elseif type(cell) == "table" then
            state = num(cell.growthState or cell.state or cell.startState or cell[1])
        end
        if state ~= nil and state >= minH and state <= maxH then
            months[#months + 1] = tostring(month)
        end
        month = month + 1
    end
    if #months == 0 then
        return nil
    end
    return table.concat(months, ",")
end

-- FS25 names each growth period. MID_WINTER is January.
local PERIOD_MONTH = {
    MID_WINTER = 1,
    LATE_WINTER = 2,
    EARLY_SPRING = 3,
    MID_SPRING = 4,
    LATE_SPRING = 5,
    EARLY_SUMMER = 6,
    MID_SUMMER = 7,
    LATE_SUMMER = 8,
    EARLY_AUTUMN = 9,
    MID_AUTUMN = 10,
    LATE_AUTUMN = 11,
    EARLY_WINTER = 12,
}

local harvestMonthCache = {}
local harvestMonthsFromTables

local function xmlString(xmlId, key)
    if getXMLString == nil or xmlId == nil then
        return nil
    end
    local ok, value = pcall(getXMLString, xmlId, key)
    if ok and type(value) == "string" and value ~= "" then
        return value
    end
    return nil
end

local function xmlBool(xmlId, key)
    if getXMLBool == nil or xmlId == nil then
        return false
    end
    local ok, value = pcall(getXMLBool, xmlId, key)
    return ok and value == true
end

local function openFruitXml(path)
    if path == nil or path == "" or loadXMLFile == nil then
        return nil
    end
    local ok, xmlId = pcall(loadXMLFile, "AgriVisionFruit", path)
    if not ok or xmlId == nil or xmlId == 0 then
        return nil
    end
    return xmlId
end

local function closeFruitXml(xmlId)
    if xmlId ~= nil and delete ~= nil then
        pcall(delete, xmlId)
    end
end

-- A month counts when the crop is harvest-ready at its start or becomes so during it.
local function harvestMonthsFromXml(xmlId)
    local ready = { harvestReady = true }
    local i = 0
    while i < 24 do
        local key = "foliageType.foliageLayer.foliageState(" .. tostring(i) .. ")"
        local name = xmlString(xmlId, key .. "#name")
        if name == nil then
            break
        end
        if xmlBool(xmlId, key .. "#isHarvestReady") then
            ready[name] = true
        end
        i = i + 1
    end
    local seen = {}
    local months = {}
    local p = 0
    while p < 12 do
        local key = "foliageType.growth.seasonal.period(" .. tostring(p) .. ")"
        local period = xmlString(xmlId, key .. "#name")
        if period == nil then
            break
        end
        local month = PERIOD_MONTH[string.upper(period)]
        if month ~= nil then
            local u = 0
            while u < 8 do
                local ukey = key .. ".update(" .. tostring(u) .. ")"
                local startState = xmlString(xmlId, ukey .. "#startState")
                local endState = xmlString(xmlId, ukey .. "#endState")
                if startState == nil and endState == nil then
                    break
                end
                if (startState ~= nil and ready[startState] == true) or (endState ~= nil and ready[endState] == true) then
                    if seen[month] ~= true then
                        seen[month] = true
                        months[#months + 1] = month
                    end
                end
                u = u + 1
            end
        end
        p = p + 1
    end
    if #months == 0 then
        return nil
    end
    table.sort(months)
    local out = {}
    local n = 1
    while n <= #months do
        out[n] = tostring(months[n])
        n = n + 1
    end
    return table.concat(out, ",")
end

local function xmlOn(value, depth)
    if depth > 2 or type(value) ~= "table" then
        return nil
    end
    local keys = { "xmlFilename", "filename", "configFilename", "foliageFilename", "foliageXmlFilename" }
    local k = 1
    while k <= #keys do
        local item = value[keys[k]]
        if type(item) == "string" and string.find(item, ".xml", 1, true) ~= nil then
            return item
        end
        k = k + 1
    end
    for _, item in pairs(value) do
        if type(item) == "string" then
            local lower = string.lower(item)
            if string.sub(lower, -4) == ".xml" and string.find(lower, "foliage", 1, true) ~= nil then
                return item
            end
        end
    end
    local nested = { value.foliageType, value.foliage, value.growth, value.growthData }
    local n = 1
    while n <= #nested do
        local found = xmlOn(nested[n], depth + 1)
        if found ~= nil then
            return found
        end
        n = n + 1
    end
    return nil
end

local function harvestMonthsFromFruitXml(fruit)
    local paths = {}
    local found = xmlOn(fruit, 0)
    if found ~= nil then
        paths[#paths + 1] = found
    end
    local name = type(fruit.name) == "string" and string.lower(fruit.name) or nil
    if name ~= nil and name ~= "" then
        paths[#paths + 1] = "$data/foliage/" .. name .. "/" .. name .. ".xml"
        paths[#paths + 1] = "$dataS/foliage/" .. name .. "/" .. name .. ".xml"
    end
    local i = 1
    while i <= #paths do
        local xmlId = openFruitXml(paths[i])
        if xmlId ~= nil then
            local months = harvestMonthsFromXml(xmlId)
            closeFruitXml(xmlId)
            if months ~= nil then
                return months
            end
        end
        i = i + 1
    end
    return nil
end

-- FS25 period 1 is March. Same index map as a calendar that calls getIsHarvestableInPeriod.
local PERIOD_TO_MONTH = { 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2 }

local function harvestMonthsFromPeriods(fruit)
    if fruit == nil or fruit.getIsHarvestableInPeriod == nil then
        return nil
    end
    local growthMode = nil
    if g_currentMission ~= nil and g_currentMission.missionInfo ~= nil then
        growthMode = g_currentMission.missionInfo.growthMode
    end
    if growthMode == nil then
        return nil
    end
    local months = {}
    local period = 1
    while period <= 12 do
        local ok, harvestable = pcall(fruit.getIsHarvestableInPeriod, fruit, growthMode, period)
        if not ok then
            return nil
        end
        if harvestable == true then
            months[#months + 1] = PERIOD_TO_MONTH[period]
        end
        period = period + 1
    end
    if #months == 0 then
        return nil
    end
    table.sort(months)
    local out = {}
    local n = 1
    while n <= #months do
        out[n] = tostring(months[n])
        n = n + 1
    end
    return table.concat(out, ",")
end

-- Months come from the fruit calendar. Unknown structures stay empty.
local function harvestMonths(fruit)
    if fruit == nil then
        return nil
    end
    local cacheKey = type(fruit.name) == "string" and fruit.name or ""
    if cacheKey ~= "" and harvestMonthCache[cacheKey] ~= nil then
        local cached = harvestMonthCache[cacheKey]
        if cached == false then
            return nil
        end
        return cached
    end
    local fromPeriods = harvestMonthsFromPeriods(fruit)
    if fromPeriods ~= nil then
        if cacheKey ~= "" then
            harvestMonthCache[cacheKey] = fromPeriods
        end
        return fromPeriods
    end
    local fromXml = harvestMonthsFromFruitXml(fruit)
    if fromXml ~= nil then
        if cacheKey ~= "" then
            harvestMonthCache[cacheKey] = fromXml
        end
        return fromXml
    end
    local fromTables = harvestMonthsFromTables(fruit)
    if cacheKey ~= "" then
        harvestMonthCache[cacheKey] = fromTables or false
    end
    return fromTables
end

harvestMonthsFromTables = function(fruit)
    if fruit == nil then
        return nil
    end
    local directStart = num(fruit.harvestStartMonth or fruit.minHarvestMonth)
    local directEnd = num(fruit.harvestEndMonth or fruit.maxHarvestMonth)
    if directStart ~= nil and directEnd ~= nil and directStart >= 1 and directStart <= 12 and directEnd >= 1 and directEnd <= 12 then
        local months = {}
        local month = directStart
        local guard = 0
        while guard < 12 do
            months[#months + 1] = tostring(month)
            if month == directEnd then
                break
            end
            month = month % 12 + 1
            guard = guard + 1
        end
        return table.concat(months, ",")
    end
    local minH = num(fruit.minHarvestingGrowthState)
    local maxH = num(fruit.maxHarvestingGrowthState)
    local mission = g_currentMission
    local gs = mission ~= nil and mission.growthSystem or nil
    if gs == nil or minH == nil or maxH == nil then
        return nil
    end
    local index = fruit.index
    local names = {}
    if fruit.name ~= nil then
        names[1] = fruit.name
        names[2] = string.lower(fruit.name)
        names[3] = string.upper(fruit.name)
    end
    local bags = {
        gs.fruitTypeGrowths,
        gs.growthData,
        gs.fruitTypeData,
        gs.fruitTypeDatas,
        gs.fruitGrowth,
        gs.periods,
    }
    local i = 1
    while i <= #bags do
        local bag = bags[i]
        if type(bag) == "table" then
            local row = nil
            if index ~= nil then
                row = bag[index]
            end
            if type(row) ~= "table" then
                local n = 1
                while n <= #names and type(row) ~= "table" do
                    row = bag[names[n]]
                    n = n + 1
                end
            end
            if type(row) == "table" then
                local candidates = { row.periods, row.growthPeriods, row.seasonal, row.months, row }
                local c = 1
                while c <= #candidates do
                    local found = monthsFromPeriodRow(candidates[c], minH, maxH)
                    if found ~= nil then
                        return found
                    end
                    c = c + 1
                end
            end
        end
        i = i + 1
    end
    local methods = { "getGrowthData", "getFruitTypeGrowthData", "getGrowthDataForFruitType" }
    local m = 1
    while m <= #methods do
        local method = methods[m]
        if gs[method] ~= nil and index ~= nil then
            local ok, data = pcall(function()
                return gs[method](gs, index)
            end)
            if ok and type(data) == "table" then
                local found = monthsFromPeriodRow(data.periods or data.growthPeriods or data.months or data, minH, maxH)
                if found ~= nil then
                    return found
                end
            end
        end
        m = m + 1
    end
    return nil
end

-- getFieldState() is a cache. On a dedicated server it stays on the previous
-- fruit (grass) after the density map has been sown. FieldState:update reads
-- the density map at a world position. A grass margin must not hide the crop.
local function sampleFruit(points)
    if FieldState == nil or type(points) ~= "table" or #points < 3 then
        return nil
    end
    if FieldSnapshot._sampler == nil then
        local ok, created = pcall(FieldState.new)
        if not ok or created == nil or created.update == nil then
            FieldSnapshot._sampler = false
            return nil
        end
        FieldSnapshot._sampler = created
    end
    if FieldSnapshot._sampler == false then
        return nil
    end
    local state = FieldSnapshot._sampler
    local minX, maxX, minZ, maxZ = 1e12, -1e12, 1e12, -1e12
    for _, point in ipairs(points) do
        if point.x < minX then minX = point.x end
        if point.x > maxX then maxX = point.x end
        if point.z < minZ then minZ = point.z end
        if point.z > maxZ then maxZ = point.z end
    end
    local span = math.max(maxX - minX, maxZ - minZ)
    if span < 1 then
        return nil
    end
    local step = math.max(16, span / 5)
    local unknown = FruitType ~= nil and FruitType.UNKNOWN or 0
    local tally = {}
    local growth = {}
    local extra = {}
    local total = 0
    local taken = 0
    local z = minZ + step * 0.5
    while z < maxZ and taken < 24 do
        local x = minX + step * 0.5
        while x < maxX and taken < 24 do
            if pointInside(points, x, z) then
                taken = taken + 1
                local updated = pcall(function()
                    state:update(x, z)
                end)
                local index = updated and state.isValid and num(state.fruitTypeIndex) or nil
                if index ~= nil and index ~= unknown and index > 0 then
                    tally[index] = (tally[index] or 0) + 1
                    total = total + 1
                    local stage = num(state.growthState)
                    if stage ~= nil then
                        growth[index] = growth[index] or {}
                        growth[index][stage] = (growth[index][stage] or 0) + 1
                    end
                    local bag = extra[index]
                    if bag == nil then
                        bag = {}
                        extra[index] = bag
                    end
                    tallyValue(bag, "weed", num(state.weedState))
                    tallyValue(bag, "weedFactor", state.weedFactor)
                    tallyValue(bag, "stones", num(state.stoneLevel))
                    tallyValue(bag, "ground", num(state.groundType))
                    tallyValue(bag, "spray", num(state.sprayLevel))
                    tallyValue(bag, "sprayType", num(state.sprayType))
                    tallyValue(bag, "lime", num(state.limeLevel))
                    tallyValue(bag, "roller", num(state.rollerLevel))
                    tallyValue(bag, "plow", num(state.plowLevel))
                    tallyValue(bag, "stubble", num(state.stubbleShredLevel))
                    tallyValue(bag, "water", num(state.waterLevel))
                end
            end
            x = x + step
        end
        z = z + step
    end
    if total == 0 then
        return nil
    end
    local cropIndex, cropCount = nil, 0
    local anyIndex, anyCount = nil, 0
    for index, count in pairs(tally) do
        if count > anyCount then
            anyIndex = index
            anyCount = count
        end
        local name = fruitInfo(index)
        local upper = name ~= nil and string.upper(name) or ""
        if not FORAGE_FRUIT[upper] and count > cropCount then
            cropIndex = index
            cropCount = count
        end
    end
    local index = anyIndex
    if cropIndex ~= nil and (cropCount >= anyCount or (cropCount >= 2 and cropCount / total >= 0.15)) then
        index = cropIndex
    end
    local stage, stageCount = nil, 0
    local bucket = growth[index]
    if bucket ~= nil then
        for value, count in pairs(bucket) do
            if count > stageCount then
                stage = value
                stageCount = count
            end
        end
    end
    return index, stage, packExtra(extra[index])
end

local function rememberTramline(index, farmlandId, row)
    if farmlandId == nil or type(row) ~= "table" then
        return
    end
    if row.enabled == false or row.isEnabled == false then
        return
    end
    local width = num(row.workingWidth) or num(row.width)
    local direction = num(row.workDirection)
    if direction == nil then
        direction = num(row.direction)
    end
    local spacing = num(row.spacing) or width
    if width == nil or direction == nil or spacing == nil then
        return
    end
    if width < 8 or spacing < 8 or spacing > 80 then
        return
    end
    index[farmlandId] = { width = width, direction = direction, spacing = spacing }
end

local function tramlineIndex(connector)
    if connector.tramlineIndex ~= nil then
        return connector.tramlineIndex
    end
    local index = {}
    connector.tramlineIndex = index
    local ok = pcall(function()
        local pf = getPrecisionFarming()
        local map = pf ~= nil and pf.tramlineMap or nil
        if map == nil then
            return
        end
        local keys = {
            "farmlandIdToTramline",
            "farmlandIdToTramlines",
            "farmlandTramlines",
            "tramlines",
            "tramlineData",
            "dataByFarmlandId",
        }
        local keyIndex = 1
        while keyIndex <= #keys do
            local source = map[keys[keyIndex]]
            if type(source) == "table" then
                local id, row = next(source, nil)
                while id ~= nil do
                    local capturedId = id
                    local captured = row
                    pcall(function()
                        local farmlandId = num(capturedId)
                        if farmlandId == nil and type(captured) == "table" then
                            farmlandId = num(captured.farmlandId) or num(captured.id)
                        end
                        rememberTramline(index, farmlandId, captured)
                    end)
                    id, row = next(source, id)
                end
            end
            keyIndex = keyIndex + 1
        end
    end)
    if not ok and not connector.tramlineLogged then
        connector.tramlineLogged = true
        log("tramlines unreadable")
    end
    return index
end

local function tramlineText(connector, farmlandId)
    local id = num(farmlandId)
    if id == nil then
        return nil
    end
    local row = tramlineIndex(connector)[id]
    if row == nil then
        return nil
    end
    return string.format("%.1f,%.4f,%.1f", row.width, row.direction, row.spacing)
end

local function collectState(connector, field, id)
    local record = { id = id }
    if field == nil then
        return record
    end
    local cx, cz = nil, nil
    if field.getCenterOfFieldWorldPosition ~= nil then
        local a, b = safeMethod(field, "getCenterOfFieldWorldPosition")
        cx = num(a)
        cz = num(b)
    end
    local fieldState = safeMethod(field, "getFieldState")
    local farmlandId, farmId = ownership(field, fieldState, cx, cz)
    record.farmlandId = farmlandId
    record.farmId = farmId
    if farmId ~= nil then
        record.owned = farmId > 0 and "1" or "0"
    elseif farmlandId ~= nil then
        record.owned = "0"
    end

    local polygon = collectPolygon(field)
    if fieldState ~= nil or field ~= nil then
        local fruitTypeIndex = fieldState ~= nil and num(fieldState.fruitTypeIndex) or nil
        local growth = fieldState ~= nil and num(fieldState.growthState) or nil
        local liveIndex, liveGrowth, live = sampleFruit(polygon)
        if liveIndex ~= nil then
            fruitTypeIndex = liveIndex
            if liveGrowth ~= nil then
                growth = liveGrowth
            end
        end
        local fruitName, fruitTitle, fruit = fruitInfo(fruitTypeIndex)
        record.fruit = fruitName
        record.fruitTitle = fruitTitle
        record.fruitIcon = queueFruitIcon(connector, fruit)
        record.growth = growth
        if fruit ~= nil then
            record.growthMax = num(fruit.numGrowthStates)
            record.harvestMin = num(fruit.minHarvestingGrowthState)
            record.harvestMax = num(fruit.maxHarvestingGrowthState)
            record.harvestMonths = harvestMonths(fruit)
            record.crop = classifyCrop(fruit, record.growth)
        else
            record.crop = "noCrop"
        end
        local function pick(liveValue, cached)
            if liveIndex ~= nil and liveValue ~= nil then
                return liveValue
            end
            return cached
        end
        record.ground = pick(live ~= nil and live.ground or nil, fieldState ~= nil and num(fieldState.groundType) or nil)
        record.weed = pick(live ~= nil and live.weed or nil, fieldState ~= nil and num(fieldState.weedState) or nil)
        record.weedFactor = round(pick(live ~= nil and live.weedFactor or nil, fieldState ~= nil and fieldState.weedFactor or nil), 3)
        record.stones = pick(live ~= nil and live.stones or nil, fieldState ~= nil and num(fieldState.stoneLevel) or nil)
        record.spray = pick(live ~= nil and live.spray or nil, fieldState ~= nil and num(fieldState.sprayLevel) or nil)
        record.sprayType = pick(live ~= nil and live.sprayType or nil, fieldState ~= nil and num(fieldState.sprayType) or nil)
        record.lime = pick(live ~= nil and live.lime or nil, fieldState ~= nil and num(fieldState.limeLevel) or nil)
        record.roller = pick(live ~= nil and live.roller or nil, fieldState ~= nil and num(fieldState.rollerLevel) or nil)
        record.plow = pick(live ~= nil and live.plow or nil, fieldState ~= nil and num(fieldState.plowLevel) or nil)
        record.stubble = pick(live ~= nil and live.stubble or nil, fieldState ~= nil and num(fieldState.stubbleShredLevel) or nil)
        record.water = pick(live ~= nil and live.water or nil, fieldState ~= nil and num(fieldState.waterLevel) or nil)
    end

    local precision = samplePrecision(getPrecisionFarming(), farmlandId, cx, cz, fieldState ~= nil and fieldState.fruitTypeIndex or nil)
    record.precisionAvailable = precision.available == true
    if precision.available == true then
        record.scanned = precision.scanned == true and "1" or "0"
        record.n = round(precision.nitrogen, 1)
        record.nTarget = round(precision.nitrogenTarget, 1)
        record.ph = round(precision.ph, 2)
        record.phTarget = round(precision.phTarget, 2)
        record.soil = precision.soil
        record.soilName = precision.soilName
        record.pf = precisionGrid(getPrecisionFarming(), farmlandId, polygon)
    end
    record.tram = tramlineText(connector, farmlandId)
    return record
end

local function readNumber(object, name)
    if object == nil then
        return nil
    end
    local ok, value = pcall(function()
        return object[name]
    end)
    if not ok then
        return nil
    end
    return num(value)
end

local function mapFrameAttrs(connector)
    local mission = g_currentMission
    if mission == nil or mission.hud == nil or mission.hud.ingameMap == nil then
        return ""
    end
    local map = mission.hud.ingameMap
    local worldX = readNumber(map, "worldSizeX")
    local worldZ = readNumber(map, "worldSizeZ")
    if worldX == nil or worldZ == nil or worldX <= 1 or worldZ <= 1 then
        return ""
    end
    local originX = readNumber(map, "worldCenterOffsetX") or (worldX * 0.5)
    local originZ = readNumber(map, "worldCenterOffsetZ") or (worldZ * 0.5)
    local scaleX = readNumber(map, "mapExtensionScaleFactor")
    local scaleZ = readNumber(map, "mapExtensionScaleFactorZ") or scaleX
    local padX = readNumber(map, "mapExtensionOffsetX")
    local padZ = readNumber(map, "mapExtensionOffsetZ")
    if scaleX == nil or scaleZ == nil or padX == nil or padZ == nil then
        return ""
    end
    return table.concat({
        attr(connector, "mapWorldX", string.format("%.1f", worldX)),
        attr(connector, "mapWorldZ", string.format("%.1f", worldZ)),
        attr(connector, "mapOriginX", string.format("%.1f", originX)),
        attr(connector, "mapOriginZ", string.format("%.1f", originZ)),
        attr(connector, "mapScaleX", string.format("%.4f", scaleX)),
        attr(connector, "mapScaleZ", string.format("%.4f", scaleZ)),
        attr(connector, "mapPadX", string.format("%.4f", padX)),
        attr(connector, "mapPadZ", string.format("%.4f", padZ)),
    }, "")
end

local function readString(object, name)
    if object == nil then
        return nil
    end
    local ok, value = pcall(function()
        return object[name]
    end)
    if not ok or type(value) ~= "string" or value == "" then
        return nil
    end
    return value
end

-- The running map's PDA texture, resolved the same way the game loads it:
-- map.xml imageFilename under the mission base directory, then overview.dds.
local function overviewSource()
    local mission = g_currentMission
    if mission == nil or mission.missionInfo == nil then
        return nil
    end
    local info = mission.missionInfo
    local base = readString(info, "baseDirectory")
    local fallback = nil
    if base ~= nil then
        fallback = base .. "overview.dds"
    end
    if base == nil or g_mapManager == nil or info.mapId == nil or g_mapManager.getMapById == nil then
        return fallback
    end
    local ok, entry = pcall(function()
        return g_mapManager:getMapById(info.mapId)
    end)
    if not ok or entry == nil then
        return fallback
    end
    local cfg = readString(entry, "configFilename")
    if cfg == nil then
        cfg = readString(entry, "xmlFilename")
    end
    if cfg == nil then
        cfg = readString(entry, "filename")
    end
    if cfg == nil then
        cfg = readString(entry, "mapXMLFilename")
    end
    if cfg == nil or loadXMLFile == nil or getXMLString == nil then
        return fallback
    end
    local xmlId = safeCall(loadXMLFile, "AgriVisionMap", base .. cfg)
    if xmlId == nil or xmlId == 0 then
        return fallback
    end
    local img = safeCall(getXMLString, xmlId, "map#imageFilename")
    if delete ~= nil then
        pcall(delete, xmlId)
    end
    if type(img) ~= "string" or img == "" or Utils == nil or Utils.getFilename == nil then
        return fallback
    end
    local resolved = safeCall(Utils.getFilename, img, base)
    if type(resolved) ~= "string" or resolved == "" then
        return fallback
    end
    if fileExists ~= nil then
        local dds = string.gsub(resolved, "%.[pP][nN][gG]$", ".dds")
        if dds ~= resolved then
            local existsOk, exists = pcall(fileExists, dds)
            if existsOk and exists then
                return dds
            end
        end
    end
    return resolved
end

local function copyOverview(connector)
    if connector.pdaCopied or connector.copyIconFile == nil or connector.stateDir == nil then
        return
    end
    local now = 0
    if g_time ~= nil then
        now = g_time
    end
    if connector.pdaNextTry ~= nil and now < connector.pdaNextTry then
        return
    end
    connector.pdaNextTry = now + 60000
    local src = overviewSource()
    if src == nil then
        return
    end
    local ext = ".dds"
    if string.sub(string.lower(src), -4) == ".png" then
        ext = ".png"
    end
    local ok = connector:copyIconFile(src, connector.stateDir .. "overview" .. ext)
    if ok then
        connector.pdaCopied = true
        log("pda overview copied")
    end
end

local function onFieldGround(x, z)
    if FSDensityMapUtil == nil or FSDensityMapUtil.getFieldDataAtWorldPosition == nil then
        return nil
    end
    local y = 0
    if g_terrainNode ~= nil and getTerrainHeightAtWorldPos ~= nil then
        local height = num(safeCall(getTerrainHeightAtWorldPos, g_terrainNode, x, 0, z))
        if height ~= nil then
            y = height
        end
    end
    local ok, isOnField = pcall(function()
        return FSDensityMapUtil.getFieldDataAtWorldPosition(x, y, z)
    end)
    if not ok then
        return nil
    end
    return isOnField == true
end

-- The nearest corners of two parcels often sit in a road. The shared edge
-- is the place a plow actually joins them, so corridors are measured
-- edge to edge and only kept when they fall outside both outlines.
local JOIN_METERS = 48

local function pointInPolygon(points, x, z)
    local count = #points
    if count < 3 then
        return false
    end
    local hit = false
    local j = count
    local i = 1
    while i <= count do
        local xi = points[i].x
        local zi = points[i].z
        local xj = points[j].x
        local zj = points[j].z
        if (zi > z) ~= (zj > z) then
            local denom = zj - zi
            if denom ~= 0 and x < ((xj - xi) * (z - zi) / denom) + xi then
                hit = not hit
            end
        end
        j = i
        i = i + 1
    end
    return hit
end

local function pointOnSegment(px, pz, ax, az, bx, bz)
    local dx = bx - ax
    local dz = bz - az
    local len2 = dx * dx + dz * dz
    local t = 0
    if len2 > 0.0001 then
        t = ((px - ax) * dx + (pz - az) * dz) / len2
        if t < 0 then
            t = 0
        elseif t > 1 then
            t = 1
        end
    end
    return ax + t * dx, az + t * dz
end

local function corridorOutside(a, b, ax, az, bx, bz)
    local t = 0.3
    while t <= 0.7 do
        local x = ax + (bx - ax) * t
        local z = az + (bz - az) * t
        if pointInPolygon(a, x, z) or pointInPolygon(b, x, z) then
            return false
        end
        t = t + 0.2
    end
    return true
end

local function pushCorridors(found, from, onto, maxDist)
    local fromCount = #from
    local ontoCount = #onto
    if fromCount < 2 or ontoCount < 2 then
        return
    end
    local stepFrom = math.max(1, math.floor(fromCount / 24))
    local stepOnto = math.max(1, math.floor(ontoCount / 32))
    local max2 = maxDist * maxDist
    local i = 1
    while i <= fromCount do
        local p = from[i]
        local n = from[(i % fromCount) + 1]
        local f = 1
        while f <= 3 do
            local frac = f / 4
            local mx = p.x + (n.x - p.x) * frac
            local mz = p.z + (n.z - p.z) * frac
            local best = max2 + 1
            local bx, bz = nil, nil
            local j = 1
            while j <= ontoCount do
                local q = onto[j]
                local m = onto[(j % ontoCount) + 1]
                local qx, qz = pointOnSegment(mx, mz, q.x, q.z, m.x, m.z)
                local dx = mx - qx
                local dz = mz - qz
                local dist = dx * dx + dz * dz
                if dist < best then
                    best = dist
                    bx = qx
                    bz = qz
                end
                j = j + stepOnto
            end
            if bx ~= nil and best <= max2 and best >= 0.16 then
                if corridorOutside(from, onto, mx, mz, bx, bz) then
                    found[#found + 1] = { dist = math.sqrt(best), ax = mx, az = mz, bx = bx, bz = bz }
                end
            end
            f = f + 1
        end
        i = i + stepFrom
    end
end

local function boundaryCorridors(a, b, maxDist)
    local found = {}
    pushCorridors(found, a, b, maxDist)
    pushCorridors(found, b, a, maxDist)
    table.sort(found, function(p, q)
        return p.dist < q.dist
    end)
    local kept = {}
    local k = 1
    while k <= #found and #kept < 3 do
        local row = found[k]
        local distinct = true
        local c = 1
        while c <= #kept do
            local prev = kept[c]
            local dx = row.ax - prev.ax
            local dz = row.az - prev.az
            if dx * dx + dz * dz < 900 then
                distinct = false
                break
            end
            c = c + 1
        end
        if distinct then
            kept[#kept + 1] = row
        end
        k = k + 1
    end
    return kept
end

local function corridorIsField(link)
    local t = 0.35
    while t <= 0.65 do
        local x = link.ax + (link.bx - link.ax) * t
        local z = link.az + (link.bz - link.az) * t
        if onFieldGround(x, z) ~= true then
            return false
        end
        t = t + 0.15
    end
    return true
end

-- Fields the player has plowed together stay as separate ids. The join is
-- field ground between the original outlines. Confirmed samples only.
local function assignGroups(records)
    for _, row in pairs(records) do
        row.group = nil
    end
    local ids = {}
    for id, row in pairs(records) do
        if type(row.raw) == "table" and #row.raw >= 3 then
            ids[#ids + 1] = id
        end
    end
    table.sort(ids)
    local bounds = {}
    for _, id in ipairs(ids) do
        local minX, maxX, minZ, maxZ = 1e12, -1e12, 1e12, -1e12
        for _, point in ipairs(records[id].raw) do
            if point.x < minX then minX = point.x end
            if point.x > maxX then maxX = point.x end
            if point.z < minZ then minZ = point.z end
            if point.z > maxZ then maxZ = point.z end
        end
        bounds[id] = { minX = minX, maxX = maxX, minZ = minZ, maxZ = maxZ }
    end
    local parent = {}
    local function find(id)
        local root = parent[id] or id
        if root ~= id then
            root = find(root)
            parent[id] = root
        else
            parent[id] = id
        end
        return parent[id]
    end
    local function unite(a, b)
        local ra = find(a)
        local rb = find(b)
        if ra ~= rb then
            parent[rb] = ra
        end
    end
    local i = 1
    while i <= #ids do
        local j = i + 1
        while j <= #ids do
            local a = ids[i]
            local b = ids[j]
            local boxA = bounds[a]
            local boxB = bounds[b]
            local gapX = 0
            if boxA.maxX < boxB.minX then
                gapX = boxB.minX - boxA.maxX
            elseif boxB.maxX < boxA.minX then
                gapX = boxA.minX - boxB.maxX
            end
            local gapZ = 0
            if boxA.maxZ < boxB.minZ then
                gapZ = boxB.minZ - boxA.maxZ
            elseif boxB.maxZ < boxA.minZ then
                gapZ = boxA.minZ - boxB.maxZ
            end
            if gapX * gapX + gapZ * gapZ <= JOIN_METERS * JOIN_METERS then
                local corridors = boundaryCorridors(records[a].raw, records[b].raw, JOIN_METERS)
                local c = 1
                while c <= #corridors do
                    if corridorIsField(corridors[c]) then
                        unite(a, b)
                        c = #corridors + 1
                    else
                        c = c + 1
                    end
                end
            end
            j = j + 1
        end
        i = i + 1
    end
    local members = {}
    for _, id in ipairs(ids) do
        local root = find(id)
        members[root] = members[root] or {}
        members[root][#members[root] + 1] = id
    end
    for _, list in pairs(members) do
        if #list >= 2 then
            table.sort(list)
            local text = table.concat(list, " ")
            for _, id in ipairs(list) do
                records[id].group = text
            end
        end
    end
end

local function writeGeometry(connector, ids, records)
    local lines = {}
    for _, id in ipairs(ids) do
        local row = records[id]
        if row ~= nil then
            lines[#lines + 1] = string.format(
                "<field%s%s%s%s%s%s%s%s />",
                attr(connector, "id", row.id),
                attr(connector, "cx", row.cx),
                attr(connector, "cz", row.cz),
                attr(connector, "lx", row.lx),
                attr(connector, "lz", row.lz),
                attr(connector, "areaHa", row.areaHa),
                attr(connector, "group", row.group),
                attr(connector, "points", row.points)
            )
        end
    end
    local body = string.format(
        '<?xml version="1.0" encoding="utf-8"?>\n<fieldsGeometry schema="1" generation="%s" writtenAtUtc="%s"%s%s>\n%s\n</fieldsGeometry>\n',
        tostring(connector:nextGeneration()),
        xmlEscape(connector, (getDate ~= nil and getDate("%Y-%m-%dT%H:%M:%SZ")) or "unknown"),
        attr(connector, "mapSize", terrainSize() ~= nil and math.floor(terrainSize()) or nil),
        mapFrameAttrs(connector),
        table.concat(lines, "\n")
    )
    connector:writeTextFile(connector.stateDir .. "fields_geometry.xml", body)
end

local function stateLine(connector, row)
    return string.format(
        "<field%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s%s />",
        attr(connector, "id", row.id),
        attr(connector, "farmId", row.farmId),
        attr(connector, "farmlandId", row.farmlandId),
        attr(connector, "owned", row.owned),
        attr(connector, "fruit", row.fruit),
        attr(connector, "fruitTitle", row.fruitTitle),
        attr(connector, "fruitIcon", row.fruitIcon),
        attr(connector, "growth", row.growth),
        attr(connector, "growthMax", row.growthMax),
        attr(connector, "harvestMin", row.harvestMin),
        attr(connector, "harvestMax", row.harvestMax),
        attr(connector, "harvestMonths", row.harvestMonths),
        attr(connector, "crop", row.crop),
        attr(connector, "ground", row.ground),
        attr(connector, "weed", row.weed),
        attr(connector, "weedFactor", row.weedFactor),
        attr(connector, "stones", row.stones),
        attr(connector, "spray", row.spray),
        attr(connector, "sprayType", row.sprayType),
        attr(connector, "lime", row.lime),
        attr(connector, "roller", row.roller),
        attr(connector, "plow", row.plow),
        attr(connector, "stubble", row.stubble),
        attr(connector, "water", row.water),
        attr(connector, "scanned", row.scanned),
        attr(connector, "n", row.n),
        attr(connector, "nTarget", row.nTarget),
        attr(connector, "ph", row.ph),
        attr(connector, "phTarget", row.phTarget),
        attr(connector, "soil", row.soil),
        attr(connector, "soilName", row.soilName),
        attr(connector, "pf", row.pf),
        attr(connector, "tram", row.tram)
    )
end

local function writeState(connector, ids, records)
    local lines = {}
    local precision = "0"
    for _, id in ipairs(ids) do
        local row = records[id]
        if row ~= nil then
            if row.precisionAvailable then
                precision = "1"
            end
            lines[#lines + 1] = stateLine(connector, row)
        end
    end
    local body = string.format(
        '<?xml version="1.0" encoding="utf-8"?>\n<fieldsState schema="1" generation="%s" writtenAtUtc="%s" precisionFarming="%s">\n%s\n</fieldsState>\n',
        tostring(connector:nextGeneration()),
        xmlEscape(connector, (getDate ~= nil and getDate("%Y-%m-%dT%H:%M:%SZ")) or "unknown"),
        precision,
        table.concat(lines, "\n")
    )
    connector:writeTextFile(connector.stateDir .. "fields_state.xml", body)
end

local function copyPendingFruitIcons(connector, budget)
    local pending = connector.pendingFruitIcons
    if pending == nil or connector.copyIconFile == nil or connector.fruitsIconsDir == nil then
        return
    end
    connector.copiedFruitIcons = connector.copiedFruitIcons or {}
    local copied = 0
    for key, src in pairs(pending) do
        if copied >= budget then
            break
        end
        local candidates = {}
        local function push(path)
            if path == nil or path == "" or isGameArchivePath(path) then
                return
            end
            local n = #candidates
            local j = 1
            while j <= n do
                if candidates[j] == path then
                    return
                end
                j = j + 1
            end
            if connector.engineFileExists ~= nil and connector:engineFileExists(path) then
                candidates[#candidates + 1] = path
            end
        end
        push(src)
        if connector.buildStoreImageCandidates ~= nil then
            local expanded = connector:buildStoreImageCandidates(src)
            if type(expanded) == "table" then
                local j = 1
                while j <= #expanded do
                    push(expanded[j])
                    j = j + 1
                end
            end
        end
        local c = 1
        local wrote = false
        while c <= #candidates do
            local candidate = candidates[c]
            local ext = "dds"
            if connector.iconExtFromPath ~= nil then
                ext = connector:iconExtFromPath(candidate)
            end
            local dest = connector.fruitsIconsDir .. key .. "." .. ext
            if connector:copyIconFile(candidate, dest) then
                connector.copiedFruitIcons[key] = "icons/fruits/" .. key .. "." .. ext
                pending[key] = nil
                copied = copied + 1
                wrote = true
                c = #candidates + 1
            else
                c = c + 1
            end
        end
        if not wrote then
            pending[key] = nil
        end
    end
    if copied > 0 then
        log("fruit icons from mods copied=" .. tostring(copied))
    end
end

local function writeFruitManifest(connector)
    local copied = connector.copiedFruitIcons
    if copied == nil then
        return
    end
    local lines = {}
    for key, rel in pairs(copied) do
        lines[#lines + 1] = string.format(
            "<fruit%s%s />",
            attr(connector, "key", key),
            attr(connector, "iconFile", rel)
        )
    end
    table.sort(lines)
    local fingerprint = table.concat(lines, "")
    if fingerprint == connector.fruitManifestFingerprint then
        return
    end
    local body = string.format(
        '<?xml version="1.0" encoding="utf-8"?>\n<fruitsManifest schema="1" generation="%s" writtenAtUtc="%s">\n%s\n</fruitsManifest>\n',
        tostring(connector:nextGeneration()),
        xmlEscape(connector, (getDate ~= nil and getDate("%Y-%m-%dT%H:%M:%SZ")) or "unknown"),
        fingerprint
    )
    connector:writeTextFile(connector.stateDir .. "fruits_manifest.xml", body)
    connector.fruitManifestFingerprint = fingerprint
end

local function geometryFingerprint(connector, ids, records)
    local parts = {}
    for _, id in ipairs(ids) do
        local row = records[id]
        if row ~= nil then
            parts[#parts + 1] = tostring(row.id) .. ":" .. tostring(row.lx) .. "," .. tostring(row.lz) .. ":" .. tostring(row.group or "") .. ":" .. tostring(row.points or "")
        end
    end
    return table.concat(parts, "|") .. "#" .. mapFrameAttrs(connector)
end

function FieldSnapshot.writeIfDue(connector)
    if connector == nil or connector.stateDir == nil or connector.writeTextFile == nil then
        return
    end
    if not connector.fruitDirReady and connector.fruitsIconsDir ~= nil and createFolder ~= nil then
        pcall(createFolder, connector.fruitsIconsDir)
        connector.fruitDirReady = true
    end
    copyOverview(connector)

    local ids, byId, hidden = indexFields()
    if not connector.hiddenFieldsLogged then
        connector.hiddenFieldsLogged = true
        log(string.format("fields listed=%s hiddenFarmland=%s", tostring(#ids), tostring(hidden)))
    end
    if #ids == 0 then
        return
    end

    if connector.fieldGeometryDone and connector.fieldGeometryCount ~= #ids then
        connector.fieldGeometryDone = false
        connector.fieldGeoIndex = 1
        connector.fieldGeoRecords = {}
        connector.fieldGeoCache = nil
        connector.fieldGeometryFingerprint = nil
        connector.fieldStateIndex = nil
        connector.fieldStateRecords = nil
        connector.fieldStateIds = nil
    end

    if not connector.fieldGeometryDone then
        connector.fieldGeoRecords = connector.fieldGeoRecords or {}
        connector.fieldGeoIndex = connector.fieldGeoIndex or 1
        local budget = FieldSnapshot.GEOMETRY_BUDGET
        while budget > 0 and connector.fieldGeoIndex <= #ids do
            local id = ids[connector.fieldGeoIndex]
            connector.fieldGeoRecords[id] = collectGeometry(byId[id], id)
            connector.fieldGeoIndex = connector.fieldGeoIndex + 1
            budget = budget - 1
        end
        if connector.fieldGeoIndex > #ids then
            assignGroups(connector.fieldGeoRecords)
            local fingerprint = geometryFingerprint(connector, ids, connector.fieldGeoRecords)
            if fingerprint ~= connector.fieldGeometryFingerprint then
                writeGeometry(connector, ids, connector.fieldGeoRecords)
                connector.fieldGeometryFingerprint = fingerprint
                if not connector.fieldGeometryLogged then
                    log(string.format("fields geometry written count=%s", tostring(#ids)))
                    connector.fieldGeometryLogged = true
                end
            end
            connector.fieldGeometryDone = true
            connector.fieldGeometryCount = #ids
            connector.fieldGeoCache = connector.fieldGeoRecords
            connector.fieldGeoRecords = nil
        end
        return
    end

    connector.fieldAccumMs = (connector.fieldAccumMs or 0) + (connector.TICK_MS or 5000)
    if connector.fieldStateIds ~= nil and #connector.fieldStateIds ~= #ids then
        connector.fieldStateIndex = nil
        connector.fieldStateRecords = nil
        connector.fieldStateIds = nil
    end

    if connector.fieldStateIndex == nil then
        if connector.fieldStateWritten and connector.fieldAccumMs < FieldSnapshot.STATE_EVERY_MS then
            copyPendingFruitIcons(connector, 24)
            writeFruitManifest(connector)
            return
        end
        connector.fieldAccumMs = 0
        connector.tramlineIndex = nil
        connector.fieldStateIndex = 1
        connector.fieldStateRecords = {}
        connector.fieldStateIds = ids
    end

    local budget = getPrecisionFarming() ~= nil and FieldSnapshot.STATE_BUDGET_PF or FieldSnapshot.STATE_BUDGET
    local stateIds = connector.fieldStateIds
    while budget > 0 and connector.fieldStateIndex <= #stateIds do
        local id = stateIds[connector.fieldStateIndex]
        connector.fieldStateRecords[id] = collectState(connector, byId[id], id)
        connector.fieldStateIndex = connector.fieldStateIndex + 1
        budget = budget - 1
    end

    if connector.fieldStateIndex > #stateIds then
        if connector.fieldGeoCache ~= nil then
            assignGroups(connector.fieldGeoCache)
            local fingerprint = geometryFingerprint(connector, stateIds, connector.fieldGeoCache)
            if fingerprint ~= connector.fieldGeometryFingerprint then
                writeGeometry(connector, stateIds, connector.fieldGeoCache)
                connector.fieldGeometryFingerprint = fingerprint
            end
        end
        writeState(connector, stateIds, connector.fieldStateRecords)
        copyPendingFruitIcons(connector, 24)
        writeFruitManifest(connector)
        if not connector.fieldStateLogged then
            log(string.format("fields state written count=%s", tostring(#stateIds)))
            connector.fieldStateLogged = true
        end
        connector.fieldStateWritten = true
        connector.fieldStateIndex = nil
        connector.fieldStateRecords = nil
        connector.fieldStateIds = nil
    end
end
