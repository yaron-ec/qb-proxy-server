/**
 * Universal Date Sorting Utility
 * 
 * Ensures consistent, predictable date-based sorting across the CRM:
 * - Upcoming dates first (closest to today)
 * - Future dates after
 * - Past/expired dates after future dates
 * - Empty/null dates always last
 */

export const sortByDateField = (items, dateFieldName) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return [...items].sort((a, b) => {
    const dateA = a[dateFieldName] ? new Date(a[dateFieldName]) : null;
    const dateB = b[dateFieldName] ? new Date(b[dateFieldName]) : null;

    // Both have dates
    if (dateA && dateB) {
      const isAFuture = dateA >= today;
      const isBFuture = dateB >= today;

      // Both future: sort ascending (closest first)
      if (isAFuture && isBFuture) {
        return (dateA - dateB) / (1000 * 60 * 60 * 24);
      }

      // Both past: sort descending (most recent first)
      if (!isAFuture && !isBFuture) {
        return (dateB - dateA) / (1000 * 60 * 60 * 24);
      }

      // One future, one past: future comes first
      return isAFuture ? -1 : 1;
    }

    // Only A has date (comes first)
    if (dateA && !dateB) return -1;

    // Only B has date (comes first)
    if (!dateA && dateB) return 1;

    // Neither has date (maintain original order)
    return 0;
  });
};

export const sortByMultipleDateFields = (items, dateFieldNames) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return [...items].sort((a, b) => {
    // For each field, find the closest upcoming date
    const getClosestDate = (item) => {
      let closestDate = null;
      let closestDays = Infinity;

      dateFieldNames.forEach(fieldName => {
        const date = item[fieldName] ? new Date(item[fieldName]) : null;
        if (date) {
          const days = date >= today ? (date - today) / (1000 * 60 * 60 * 24) : Infinity + (date - today) / (1000 * 60 * 60 * 24);
          if (days < closestDays) {
            closestDays = days;
            closestDate = date;
          }
        }
      });

      return { date: closestDate, days: closestDays };
    };

    const resultA = getClosestDate(a);
    const resultB = getClosestDate(b);

    // Both have dates
    if (resultA.date && resultB.date) {
      return resultA.days - resultB.days;
    }

    // Only A has date
    if (resultA.date && !resultB.date) return -1;

    // Only B has date
    if (!resultA.date && resultB.date) return 1;

    // Neither has date
    return 0;
  });
};