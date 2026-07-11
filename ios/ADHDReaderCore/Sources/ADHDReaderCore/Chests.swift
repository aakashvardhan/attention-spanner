import Foundation

/// Mystery-chest roll — variable-ratio bonus XP, ported from `src/shared/chests.ts`.
/// `rand` is injectable so tests are deterministic.
public enum Chests {
    public static let dropRate = 0.15

    /// Bonus tiers with cumulative-scan weights (sum to 1).
    static let tiers: [(bonusXp: Int, weight: Double)] = [
        (10, 0.7), (25, 0.25), (50, 0.05),
    ]

    /// Returns the chest's bonus XP, or nil when no chest drops.
    public static func rollChest(_ rand: () -> Double = { Double.random(in: 0..<1) }) -> Int? {
        if rand() >= dropRate { return nil }
        var roll = rand()
        for tier in tiers {
            if roll < tier.weight { return tier.bonusXp }
            roll -= tier.weight
        }
        return tiers.last!.bonusXp
    }
}
